import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKdfLimiter,
  createPasswordVerifier,
  filePasswordIo,
  KdfQueueFullError,
  KDF_CONCURRENCY,
  parsePasswordVerifier,
  PASSWORD_FILENAME,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyProblem,
  readPasswordState,
  serializePasswordVerifier,
  verifyPassword,
  type PasswordVerifier,
} from "./password.ts";
import type { JsonObject, JsonValue } from "./json.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-password-"));
  dirs.push(dir);
  return dir;
}

const fixedRandom = (byte: number) => (n: number) => Buffer.alloc(n, byte);

function verifier(over: Partial<PasswordVerifier> = {}): PasswordVerifier {
  return {
    version: 1,
    kdf: "scrypt",
    salt: Buffer.alloc(16, 7).toString("base64url"),
    n: 32_768,
    r: 8,
    p: 1,
    keyLen: 32,
    verifier: Buffer.alloc(32, 9).toString("base64url"),
    ...over,
  };
}

/** The parser takes untrusted JSON, so the fixture crosses the same boundary a file does. */
function asJson(value: PasswordVerifier | JsonObject): JsonValue {
  // SAFETY: the fixture is a JSON object literal; the round trip proves the shape the parser checks.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe("password policy", () => {
  test("12 code points is the floor and 256 is the ceiling", () => {
    expect(passwordPolicyProblem("a".repeat(PASSWORD_MIN_LENGTH - 1))).toContain("at least");
    expect(passwordPolicyProblem("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordPolicyProblem("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordPolicyProblem("a".repeat(PASSWORD_MAX_LENGTH + 1))).toContain("at most");
  });

  test("the byte ceiling bounds a body even at the character ceiling", () => {
    // 256 code points is the character ceiling; the widest UTF-8 code point is 4 bytes, so the
    // byte ceiling (1024) is exactly reachable and never exceeded from a policy-valid string. It is
    // still checked, and a code-point string that is too long is refused on the character bound.
    expect(PASSWORD_MAX_BYTES).toBe(PASSWORD_MAX_LENGTH * 4);
    expect(passwordPolicyProblem("😀".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(Buffer.byteLength("😀".repeat(PASSWORD_MAX_LENGTH), "utf8")).toBe(PASSWORD_MAX_BYTES);
    expect(passwordPolicyProblem("😀".repeat(PASSWORD_MAX_LENGTH + 1))).toContain("at most");
  });

  test("code points, not UTF-16 units, decide the floor", () => {
    // 12 astral characters are 24 UTF-16 units but still 12 code points.
    expect(passwordPolicyProblem("😀".repeat(12))).toBeNull();
    expect(passwordPolicyProblem("😀".repeat(11))).toContain("at least");
  });
});

describe("scrypt verifier", () => {
  test("a verifier verifies its password and refuses another", async () => {
    const v = await createPasswordVerifier("correct horse battery", fixedRandom(3));
    expect(await verifyPassword(v, "correct horse battery")).toBe(true);
    expect(await verifyPassword(v, "correct horse batterY")).toBe(false);
    expect(await verifyPassword(v, "short")).toBe(false);
  });

  test("every set gets a fresh salt, so two equal passwords do not share a verifier", async () => {
    let byte = 0;
    const sequence = (n: number) => Buffer.alloc(n, byte++);
    const a = await createPasswordVerifier("same password twice", sequence);
    const b = await createPasswordVerifier("same password twice", sequence);
    expect(a.salt).not.toBe(b.salt);
    expect(a.verifier).not.toBe(b.verifier);
  });

  test("parse accepts only the exact whitelist", () => {
    const good = verifier();
    expect(parsePasswordVerifier(asJson(good))).toEqual(good);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, kdf: "pbkdf2" },
      { ...good, n: 16_384 },
      { ...good, r: 4 },
      { ...good, p: 2 },
      { ...good, keyLen: 16 },
      { ...good, salt: "AAAA" },
      { ...good, verifier: "AAAA" },
      { ...good, salt: `${good.salt}=` },
      { ...good, verifier: good.verifier!.toUpperCase() },
    ]) {
      expect(parsePasswordVerifier(asJson(bad))).toBeNull();
    }
  });

  test("a non-canonical base64url spelling is not a verifier", () => {
    // 16 bytes end 2 significant bits into the 22nd character; changing the unused low bits decodes
    // to the SAME bytes but re-encodes differently, so an equality check must refuse it.
    const canonical = Buffer.alloc(16, 0).toString("base64url");
    const last = canonical.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(last);
    const alternate = alphabet[index + 1]!;
    const nonCanonical = `${canonical.slice(0, -1)}${alternate}`;
    expect(Buffer.from(nonCanonical, "base64url")).toEqual(Buffer.alloc(16, 0));
    expect(parsePasswordVerifier(asJson(verifier({ salt: nonCanonical })))).toBeNull();
  });

  test("readPasswordState distinguishes absent, broken and supported", () => {
    expect(readPasswordState(null)).toEqual({ kind: "absent" });
    expect(readPasswordState("{")).toMatchObject({ kind: "invalid" });
    expect(readPasswordState(JSON.stringify(verifier()))).toMatchObject({ kind: "ok" });
    expect(readPasswordState(JSON.stringify(verifier({ n: 1 })))).toMatchObject({ kind: "invalid" });
  });
});

describe("the verifier file", () => {
  test("writes 0600 with no temp file left behind, and reads back", async () => {
    const dir = await tempDir();
    const io = filePasswordIo(dir);
    await io.write(JSON.stringify(verifier()));
    const path = join(dir, PASSWORD_FILENAME);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
    expect(await io.read()).toContain('"kdf":"scrypt"');
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a missing file reads as null", async () => {
    expect(await filePasswordIo(await tempDir()).read()).toBeNull();
  });

  test("group or world permission is unreadable, never a credential", async () => {
    const dir = await tempDir();
    const path = join(dir, PASSWORD_FILENAME);
    await writeFile(path, JSON.stringify(verifier()), { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(filePasswordIo(dir).read()).rejects.toThrow(/group or others/);
  });

  test("a symlink is refused rather than followed", async () => {
    const dir = await tempDir();
    const target = join(dir, "elsewhere.json");
    await writeFile(target, JSON.stringify(verifier()), { mode: 0o600 });
    await symlink(target, join(dir, PASSWORD_FILENAME));
    await expect(filePasswordIo(dir).read()).rejects.toThrow(/symbolic link/);
  });

  test("a directory at the path is not a regular file", async () => {
    const dir = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, PASSWORD_FILENAME));
    await expect(filePasswordIo(dir).read()).rejects.toThrow(/not a regular file/);
  });

  test("a FIFO is refused by lstat before a read could block on it", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    const made = Bun.spawnSync(["mkfifo", join(dir, PASSWORD_FILENAME)]);
    if (made.exitCode !== 0) return; // a platform without mkfifo has no FIFO to test.
    await expect(filePasswordIo(dir).read()).rejects.toThrow(/not a regular file/);
  });

  test("an oversized file is refused before its contents are used", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, PASSWORD_FILENAME), "x".repeat(4096), { mode: 0o600 });
    await chmod(join(dir, PASSWORD_FILENAME), 0o600);
    await expect(filePasswordIo(dir).read()).rejects.toThrow(/larger than/);
  });
});

describe("the KDF limiter", () => {
  test("bounds concurrency and refuses once the queue is full", async () => {
    const limiter = createKdfLimiter(1, 1);
    let release!: () => void;
    const running = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = limiter.run(async () => "waited");
    expect(limiter.pending()).toBe(2);
    await expect(limiter.run(async () => "extra")).rejects.toBeInstanceOf(KdfQueueFullError);
    release();
    await running;
    expect(await waiting).toBe("waited");
    expect(limiter.pending()).toBe(0);
  });

  test("the production default runs more than one at a time", async () => {
    expect(KDF_CONCURRENCY).toBeGreaterThanOrEqual(2);
  });
});

describe("PasswordStore", () => {
  test("not configured, incorrect and valid are distinct", async () => {
    const dir = await tempDir();
    const { PasswordStore } = await import("./password.ts");
    const store = new PasswordStore(filePasswordIo(dir));
    expect(await store.verify("anything at all")).toEqual({ ok: false, reason: "not-configured" });
    await filePasswordIo(dir).write(serializePasswordVerifier(await createPasswordVerifier("twelve chars!", fixedRandom(1))));
    expect(await store.verify("wrong password")).toEqual({ ok: false, reason: "incorrect" });
    expect(await store.verify("twelve chars!")).toEqual({ ok: true });
  });

  test("a damaged file is unavailable, not not-configured", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, PASSWORD_FILENAME), "not json", { mode: 0o600 });
    await chmod(join(dir, PASSWORD_FILENAME), 0o600);
    const { PasswordStore } = await import("./password.ts");
    expect(await new PasswordStore(filePasswordIo(dir)).verify("anything at all")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
