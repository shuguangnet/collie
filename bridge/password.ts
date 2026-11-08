import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { readOwnerFile, removeOwnerFile, writeOwnerFileAtomic } from "./owner-file.ts";

// ── A FIXED ACCESS PASSWORD, STORED ONLY AS A VERIFIER ───────────────────────────────────────────
//
// This module is the bridge's half of `collie password set`: a scrypt verifier with a random salt,
// read per request so a CLI change lands on the running service without a restart. The password
// itself never reaches this file, the audit log or a response.
//
// FAIL-CLOSED, NOT "NOT CONFIGURED". A file that exists but cannot be read or parsed is a broken
// credential store, not an invitation to set a new password over it. `state()` reports `invalid` and
// login answers `503 password unavailable`; only the CLI's explicit `clear`/`set --force` may replace
// it. This mirrors `RegistryUnreadableError` in bridge/pairing.ts for the device registry.

/** The file under `<stateDir>`. */
export const PASSWORD_FILENAME = "access-password.json";

/** Shortest accepted password, in Unicode code points. Long enough to be worth a slow KDF. */
export const PASSWORD_MIN_LENGTH = 12;
/** Longest accepted password, in Unicode code points. Bounds a body and a KDF input. */
export const PASSWORD_MAX_LENGTH = 256;
/** Longest accepted password, in UTF-8 bytes. A 256-code-point string can be several KiB otherwise. */
export const PASSWORD_MAX_BYTES = 1024;
/** Salt size: 128 bits, fresh for every set. */
export const SALT_BYTES = 16;
/** Verifier size: 256 bits. */
export const VERIFIER_BYTES = 32;

/** scrypt cost. The only accepted values; anything else is an unsupported verifier. */
export const SCRYPT_N = 32_768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** 128 * N * r is 32 MiB; leave headroom so `scrypt` never refuses our own parameters. */
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** A login body larger than this is refused before it is parsed. */
export const PASSWORD_BODY_MAX_BYTES = 4 * 1024;
/** The verifier file is one small object; anything larger is not one and is not read. */
export const PASSWORD_FILE_MAX_BYTES = 2 * 1024;

/** How many scrypt calls may run at once in one bridge process. */
export const KDF_CONCURRENCY = 2;
/** How many login attempts may wait for a KDF slot before the route answers 503. */
export const KDF_QUEUE_MAX = 16;

/** The on-disk verifier. Only this exact shape is trusted. */
export interface PasswordVerifier {
  version: 1;
  kdf: "scrypt";
  salt: string;
  n: number;
  r: number;
  p: number;
  keyLen: number;
  verifier: string;
}

/** What reading the file established. `invalid` is a file that is there and is not a verifier. */
export type PasswordState =
  | { kind: "absent" }
  | { kind: "ok"; verifier: PasswordVerifier }
  | { kind: "invalid"; reason: string };

/** A wrong-password check, an absent password and an unreadable store are distinct outcomes. */
export type PasswordVerdict =
  | { ok: true }
  | { ok: false; reason: "incorrect" | "not-configured" | "unavailable" };

/** The file's raw text, or null when it does not exist. Anything else is thrown as unreadable. */
export interface PasswordIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  remove(): Promise<boolean>;
}

export class PasswordUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PasswordUnreadableError";
  }
}

/**
 * Whether a base64url string is EXACTLY the canonical encoding of `bytes` bytes. Checking the decoded
 * length alone would accept non-canonical trailing bits and misspelled alternates; a verifier is
 * compared byte for byte, so only the one spelling the writer emits is a verifier at all.
 */
function isCanonicalBase64UrlOf(value: JsonValue | undefined, bytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes) return false;
  return decoded.toString("base64url") === value;
}

/**
 * Parse an untrusted value as a verifier. Every key is checked and the parameter set is a whitelist:
 * an unknown version, KDF, cost or length is `null`, never a reason to run a different KDF. The
 * caller turns `null` into `invalid`, which login treats as unavailable.
 */
export function parsePasswordVerifier(raw: JsonValue | undefined): PasswordVerifier | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o: JsonObject = raw;
  if (o.version !== 1) return null;
  if (o.kdf !== "scrypt") return null;
  if (o.n !== SCRYPT_N || o.r !== SCRYPT_R || o.p !== SCRYPT_P || o.keyLen !== VERIFIER_BYTES) return null;
  if (!isCanonicalBase64UrlOf(o.salt, SALT_BYTES)) return null;
  if (!isCanonicalBase64UrlOf(o.verifier, VERIFIER_BYTES)) return null;
  return {
    version: 1,
    kdf: "scrypt",
    salt: o.salt,
    n: o.n,
    r: o.r,
    p: o.p,
    keyLen: o.keyLen,
    verifier: o.verifier,
  };
}

/** Serialise one verifier as the file's JSON. No trailing newline is needed; the writer adds none. */
export function serializePasswordVerifier(verifier: PasswordVerifier): string {
  return JSON.stringify(verifier);
}

/** Why `password` is unusable, or null when it may be set. Counted in code points, bounded in bytes. */
export function passwordPolicyProblem(password: string): string | null {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) return `the password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `the password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return `the password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  }
  return null;
}

function scrypt(password: string, salt: Buffer, verifier: PasswordVerifier): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      verifier.keyLen,
      { N: verifier.n, r: verifier.r, p: verifier.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash `password` with a fresh salt. Throws `PasswordPolicyError`-shaped values via the policy. */
export async function createPasswordVerifier(
  password: string,
  random: (n: number) => Buffer = randomBytes,
): Promise<PasswordVerifier> {
  const problem = passwordPolicyProblem(password);
  if (problem !== null) throw new Error(problem);
  const salt = random(SALT_BYTES);
  const verifier: PasswordVerifier = {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64url"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLen: VERIFIER_BYTES,
    verifier: "",
  };
  const key = await scrypt(password, salt, verifier);
  verifier.verifier = key.toString("base64url");
  return verifier;
}

/**
 * Whether `password` matches. A password outside the policy is false without running the KDF, so a
 * 10 MB body cannot turn into 10 MB of scrypt input. Constant-time comparison over the verifier.
 */
export async function verifyPassword(verifier: PasswordVerifier, password: string): Promise<boolean> {
  if (passwordPolicyProblem(password) !== null) return false;
  const expected = Buffer.from(verifier.verifier, "base64url");
  const actual = await scrypt(password, Buffer.from(verifier.salt, "base64url"), verifier);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Parse a file's text into a state. Anything present but not a verifier is `invalid`. */
export function readPasswordState(text: string | null): PasswordState {
  if (text === null) return { kind: "absent" };
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; the parser below checks every field.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return { kind: "invalid", reason: `${PASSWORD_FILENAME} is not valid JSON` };
  }
  const verifier = parsePasswordVerifier(parsed);
  return verifier === null
    ? { kind: "invalid", reason: `${PASSWORD_FILENAME} is not a supported verifier` }
    : { kind: "ok", verifier };
}

/** A `PasswordIo` over `<stateDir>`, owner-only and atomic. */
export function filePasswordIo(stateDir: string): PasswordIo {
  const path = join(stateDir, PASSWORD_FILENAME);
  const error = (message: string, options?: { cause?: unknown }) => new PasswordUnreadableError(message, options);
  return {
    read: () => readOwnerFile(path, PASSWORD_FILENAME, PASSWORD_FILE_MAX_BYTES, error),
    write: (text) => writeOwnerFileAtomic(path, PASSWORD_FILENAME, text, error),
    remove: () => removeOwnerFile(path, PASSWORD_FILENAME, error),
  };
}

/**
 * The bridge's view of the password. Reads per call: `collie password set` may land while the
 * service runs, and a login is rare enough that a file read costs nothing next to scrypt.
 */
export class PasswordStore {
  constructor(private readonly io: PasswordIo) {}

  async state(): Promise<PasswordState> {
    try {
      return readPasswordState(await this.io.read());
    } catch (err) {
      return {
        kind: "invalid",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async verify(password: string): Promise<PasswordVerdict> {
    const state = await this.state();
    if (state.kind === "absent") return { ok: false, reason: "not-configured" };
    if (state.kind === "invalid") return { ok: false, reason: "unavailable" };
    try {
      return (await verifyPassword(state.verifier, password)) ? { ok: true } : { ok: false, reason: "incorrect" };
    } catch {
      // A KDF failure is the store's problem, not a wrong password.
      return { ok: false, reason: "unavailable" };
    }
  }
}

/** The queue is full: the caller gets 503 rather than an unbounded wait. */
export class KdfQueueFullError extends Error {
  constructor() {
    super("too many password checks in flight");
    this.name = "KdfQueueFullError";
  }
}

export interface KdfLimiter {
  run<T>(op: () => Promise<T>): Promise<T>;
  /** Runners active plus waiters, for tests. */
  pending(): number;
}

/**
 * A process-wide bound on scrypt concurrency. scrypt is deliberately memory-hard (32 MiB here), so
 * a burst of logins must not let a small bridge allocate without limit. Waiters are capped; the
 * route turns the full-queue error into 503.
 */
export function createKdfLimiter(
  concurrency: number = KDF_CONCURRENCY,
  queueMax: number = KDF_QUEUE_MAX,
): KdfLimiter {
  let active = 0;
  const waiters: (() => void)[] = [];

  const start = async <T>(op: () => Promise<T>): Promise<T> => {
    active++;
    try {
      return await op();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };

  return {
    run<T>(op: () => Promise<T>): Promise<T> {
      if (active < concurrency) return start(op);
      if (waiters.length >= queueMax) return Promise.reject(new KdfQueueFullError());
      return new Promise<T>((resolve, reject) => {
        waiters.push(() => {
          void start(op).then(resolve, reject);
        });
      });
    },
    pending: () => active + waiters.length,
  };
}
