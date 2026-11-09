import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { readOwnerFile, removeOwnerFile, writeOwnerFileAtomic } from "./owner-file.ts";

// ── `collie open`: A SHORT-LIVED GUIDE, SPENT ONCE FROM A URL FRAGMENT ─────────────────────
//
// The CLI mints a 256-bit guide and writes only its SHA-256 here. The guide rides the URL fragment,
// so it never reaches a proxy's request line; the browser clears it before React Router starts and
// exchanges it once for an ordinary device token (bridge/server.ts, `/api/auth/open`).
//
// Kept apart from `pairing-pending.json` on purpose: `collie pair` and `collie open` must not
// invalidate each other, and this file has a different lifetime (two minutes) and no attempt counter
// — the value is 256 random bits, so guessing is not the threat the five-tries rule answers.

/** The file under `<stateDir>`. */
export const OPEN_GUIDE_FILENAME = "open-pending.json";
/** How long a minted guide stays claimable. `collie open` opens the browser immediately. */
export const OPEN_GUIDE_TTL_MS = 2 * 60 * 1000;
/** Guide entropy: 256 bits, base64url. */
export const OPEN_GUIDE_BYTES = 32;
/** The exact wire spelling: 43 base64url characters, no padding. */
export const OPEN_GUIDE_TOKEN_LENGTH = 43;
/** The fragment member the front end looks for. */
export const OPEN_GUIDE_FRAGMENT = "collie-open";
/** The guide file is one small object; anything larger is not one and is not read. */
export const OPEN_GUIDE_FILE_MAX_BYTES = 512;
/** How many auto-generated device labels `collie open` may try before refusing. */
export const OPEN_LABEL_ATTEMPTS = 20;
/** In-process spent hashes kept as a second line after persistent deletion; expired ones are dropped. */
export const OPEN_SPENT_MAX = 128;

export interface OpenGuide {
  version: 1;
  /** SHA-256 (hex) of the guide token. */
  tokenHash: string;
  expiresAt: number;
  /**
   * Set once the guide is being spent. A spent guide is kept for its original deadline so a failed
   * enrolment cannot make the same token claimable again, in this process or after a restart.
   */
  spent?: boolean;
}

export type OpenGuideState =
  | { kind: "absent" }
  | { kind: "ok"; guide: OpenGuide }
  | { kind: "spent" }
  | { kind: "invalid"; reason: string };

export type OpenClaimVerdict = "ok" | "no-guide" | "expired" | "bad-token";

export interface OpenGuideIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  remove(): Promise<boolean>;
}

export class OpenGuideUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenGuideUnreadableError";
  }
}

/** Whether a string is exactly what {@link mintOpenGuideToken} returns. */
export function isOpenGuideToken(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length === OPEN_GUIDE_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/** A fresh guide token. This is the only time it exists in the clear. */
export function mintOpenGuideToken(random: (n: number) => Buffer = randomBytes): string {
  return random(OPEN_GUIDE_BYTES).toString("base64url");
}

/** The stored form of `token`, expiring `ttlMs` from `now`. */
export function newOpenGuide(token: string, now: number, ttlMs = OPEN_GUIDE_TTL_MS): OpenGuide {
  return {
    version: 1,
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    expiresAt: now + ttlMs,
  };
}

/** Parse an untrusted value as a guide. Only the exact shape is trusted. */
export function coerceOpenGuide(raw: JsonValue | undefined): OpenGuide | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o: JsonObject = raw;
  if (o.version !== 1) return null;
  if (typeof o.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(o.tokenHash)) return null;
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return null;
  if (o.spent !== undefined && typeof o.spent !== "boolean") return null;
  const guide: OpenGuide = { version: 1, tokenHash: o.tokenHash, expiresAt: o.expiresAt };
  if (o.spent === true) guide.spent = true;
  return guide;
}

export function readOpenGuideState(text: string | null): OpenGuideState {
  if (text === null) return { kind: "absent" };
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; `coerceOpenGuide` re-checks it.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return { kind: "invalid", reason: `${OPEN_GUIDE_FILENAME} is not valid JSON` };
  }
  const guide = coerceOpenGuide(parsed);
  if (guide === null) return { kind: "invalid", reason: `${OPEN_GUIDE_FILENAME} is not a guide` };
  return guide.spent === true ? { kind: "spent" } : { kind: "ok", guide };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The whole decision: is this token the pending guide, and is it still alive. Pure; the caller
 * deletes the file on `ok` and on `expired`, never on a wrong token (a guess must not cancel the
 * legitimate browser's guide).
 */
export function checkOpenGuide(state: OpenGuideState, token: string, now: number): OpenClaimVerdict {
  if (state.kind === "absent" || state.kind === "invalid" || state.kind === "spent") return "no-guide";
  if (!isOpenGuideToken(token)) return "bad-token";
  if (now >= state.guide.expiresAt) return "expired";
  return digestsEqual(hashToken(token), state.guide.tokenHash) ? "ok" : "bad-token";
}

/** A `OpenGuideIo` over `<stateDir>`, owner-only and atomic. */
export function fileOpenGuideIo(stateDir: string): OpenGuideIo {
  const path = join(stateDir, OPEN_GUIDE_FILENAME);
  const error = (message: string, options?: { cause?: unknown }) => new OpenGuideUnreadableError(message, options);
  return {
    read: () => readOwnerFile(path, OPEN_GUIDE_FILENAME, OPEN_GUIDE_FILE_MAX_BYTES, error),
    write: (text) => writeOwnerFileAtomic(path, OPEN_GUIDE_FILENAME, text, error),
    remove: () => removeOwnerFile(path, OPEN_GUIDE_FILENAME, error),
  };
}

/**
 * `exchange`'s answer. Guide and enrolment refusals map to different messages, but neither permits
 * retrying a consumed guide: the operator must run `collie open` again after a commit refusal.
 */
export type OpenExchangeResult<T, F extends string> =
  | { ok: true; value: T }
  | { ok: false; source: "guide"; reason: OpenClaimVerdict }
  | { ok: false; source: "commit"; reason: F };

/** The bridge's view. Exchanges are serialised so two browser tabs cannot both spend one guide. */
export class OpenGuideStore {
  constructor(
    private readonly io: OpenGuideIo,
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  private queue: Promise<unknown> = Promise.resolve();
  /**
   * A second, in-process record of spent token hashes. Deletion is the persistent authority across
   * restart; this also rejects a replay if a faulty IO seam reports removal while retaining the file.
   */
  private readonly spent = new Map<string, number>();

  /** Drop expired tombstones, then the oldest if the bounded map is still full. */
  private pruneSpent(now: number): void {
    for (const [hash, expiresAt] of this.spent) {
      if (now >= expiresAt) this.spent.delete(hash);
    }
    while (this.spent.size > OPEN_SPENT_MAX) {
      const oldest = this.spent.keys().next().value;
      if (oldest === undefined) break;
      this.spent.delete(oldest);
    }
  }

  /** Mint and store a fresh guide; return the clear token, which is never persisted. */
  async mint(): Promise<string> {
    const token = mintOpenGuideToken(this.random);
    const guide = newOpenGuide(token, this.now());
    await this.io.write(JSON.stringify(guide));
    return token;
  }

  /** Read the stored state, or `invalid` when the file cannot be read or parsed. */
  async state(): Promise<OpenGuideState> {
    try {
      return readOpenGuideState(await this.io.read());
    } catch (err) {
      return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Check `token` and SPEND IT BEFORE running `commit` by DELETING the guide file. Deletion is the
   * persistent spend: a crash, a refused enrolment or a process restart all see the same absent file,
   * so the token can never be claimed a second time.
   *
   * The cost is deliberate: if `commit` refuses (the device cap, an unreadable registry) the guide is
   * gone and the person runs `collie open` again. That is a better outcome than a token that mints two
   * devices. A removal that throws is NOT swallowed — the exchange fails before `commit`, and the
   * route reports an unavailable service rather than pretending the token was spent.
   *
   * The whole check-remove-commit runs in this store's queue, so two tabs racing one guide cannot both
   * reach `commit`. The in-process `spent` map is a second line: if a remove claims success but the
   * file is somehow still there, the same process still refuses the token.
   */
  exchange<T, F extends string>(
    token: string,
    commit: () => Promise<{ ok: true; value: T } | { ok: false; reason: F }>,
  ): Promise<OpenExchangeResult<T, F>> {
    const next = this.queue.then(async (): Promise<OpenExchangeResult<T, F>> => {
      const now = this.now();
      this.pruneSpent(now);
      const state = await this.state();
      const verdict = checkOpenGuide(state, token, now);
      if (verdict === "expired") {
        await this.io.remove();
        return { ok: false, source: "guide", reason: "expired" };
      }
      if (verdict !== "ok") return { ok: false, source: "guide", reason: verdict };
      if (state.kind !== "ok") return { ok: false, source: "guide", reason: "no-guide" };
      const hash = hashToken(token);
      if (this.spent.has(hash)) return { ok: false, source: "guide", reason: "no-guide" };

      // PERSISTENT SPEND, before the device exists. `false` means the file vanished between the read
      // and this turn (another process removed or replaced it): that is already no guide, and no
      // device may be minted. A thrown removal fails the exchange before `commit` runs.
      const removed = await this.io.remove();
      if (!removed) return { ok: false, source: "guide", reason: "no-guide" };
      this.spent.set(hash, state.guide.expiresAt);

      const result = await commit();
      if (!result.ok) return { ok: false, source: "commit", reason: result.reason };
      return { ok: true, value: result.value };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
