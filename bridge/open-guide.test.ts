import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkOpenGuide,
  coerceOpenGuide,
  fileOpenGuideIo,
  isOpenGuideToken,
  mintOpenGuideToken,
  newOpenGuide,
  OPEN_GUIDE_FILENAME,
  OPEN_GUIDE_FILE_MAX_BYTES,
  OPEN_GUIDE_TTL_MS,
  OPEN_GUIDE_TOKEN_LENGTH,
  OpenGuideStore,
  readOpenGuideState,
  type OpenGuideIo,
} from "./open-guide.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-open-guide-"));
  dirs.push(dir);
  return dir;
}

/** A guide store over memory, with a pinned clock and token. */
function memoryStore(start = 1_000) {
  let text: string | null = null;
  let now = start;
  let writes = 0;
  const io: OpenGuideIo = {
    read: async () => text,
    write: async (next) => {
      text = next;
      writes++;
    },
    remove: async () => {
      const had = text !== null;
      text = null;
      return had;
    },
  };
  const store = new OpenGuideStore(io, () => now, (n) => Buffer.alloc(n, 0x5a));
  return {
    store,
    io,
    writes: () => writes,
    text: () => text,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("guide tokens", () => {
  test("256 bits, base64url, 43 characters", () => {
    const token = mintOpenGuideToken();
    expect(token).toHaveLength(OPEN_GUIDE_TOKEN_LENGTH);
    expect(isOpenGuideToken(token)).toBe(true);
    expect(isOpenGuideToken(`${token}=`)).toBe(false);
    expect(isOpenGuideToken("x".repeat(OPEN_GUIDE_TOKEN_LENGTH - 1))).toBe(false);
  });

  test("the stored guide holds only a hash and an expiry", () => {
    const token = mintOpenGuideToken();
    const guide = newOpenGuide(token, 5_000);
    expect(guide.expiresAt).toBe(5_000 + OPEN_GUIDE_TTL_MS);
    expect(JSON.stringify(guide)).not.toContain(token);
    expect(guide.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a wrong shape is not a guide", () => {
    expect(coerceOpenGuide(null)).toBeNull();
    expect(coerceOpenGuide({ version: 2, tokenHash: "a".repeat(64), expiresAt: 1 })).toBeNull();
    expect(coerceOpenGuide({ version: 1, tokenHash: "a".repeat(63), expiresAt: 1 })).toBeNull();
    expect(coerceOpenGuide({ version: 1, tokenHash: "a".repeat(64), expiresAt: Number.NaN })).toBeNull();
  });
});

describe("checkOpenGuide", () => {
  const token = mintOpenGuideToken();
  const state = readOpenGuideState(JSON.stringify(newOpenGuide(token, 1_000)));

  test("accepts the matching token before its deadline", () => {
    expect(checkOpenGuide(state, token, 1_001)).toBe("ok");
  });

  test("refuses a different token without touching the stored one", () => {
    expect(checkOpenGuide(state, mintOpenGuideToken(), 1_001)).toBe("bad-token");
  });

  test("expires at the deadline, not after it", () => {
    expect(checkOpenGuide(state, token, 1_000 + OPEN_GUIDE_TTL_MS)).toBe("expired");
  });

  test("no file and an unreadable one both read as no guide", () => {
    expect(checkOpenGuide({ kind: "absent" }, token, 1_000)).toBe("no-guide");
    expect(checkOpenGuide({ kind: "invalid", reason: "x" }, token, 1_000)).toBe("no-guide");
  });
});

describe("OpenGuideStore.exchange", () => {
  test("a successful commit spends the guide", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    let runs = 0;
    const answer = await m.store.exchange(token, async () => {
      runs++;
      return { ok: true as const, value: "device-token" };
    });
    expect(answer).toEqual({ ok: true, value: "device-token" });
    expect(runs).toBe(1);
    expect(m.text()).toBeNull();
    const second = await m.store.exchange(token, async () => {
      runs++;
      return { ok: true as const, value: "second" };
    });
    expect(second).toEqual({ ok: false, source: "guide", reason: "no-guide" });
    expect(runs).toBe(1);
  });

  test("a refused commit spends (deletes) the guide too; the person runs collie open again", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    const refused = await m.store.exchange(token, async () => ({ ok: false as const, reason: "device-limit" }));
    expect(refused).toEqual({ ok: false, source: "commit", reason: "device-limit" });
    expect(m.text()).toBeNull();
    const retried = await m.store.exchange(token, async () => ({ ok: true as const, value: "ok" }));
    expect(retried).toEqual({ ok: false, source: "guide", reason: "no-guide" });
    // A fresh `collie open` mints a fresh guide, which is the supported retry.
    expect(isOpenGuideToken(await m.store.mint())).toBe(true);
  });

  test("a throwing commit also spends the guide", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    await expect(
      m.store.exchange(token, async () => {
        throw new Error("registry torn");
      }),
    ).rejects.toThrow("registry torn");
    expect(m.text()).toBeNull();
    const second = await m.store.exchange(token, async () => ({ ok: true as const, value: "ok" }));
    expect(second).toEqual({ ok: false, source: "guide", reason: "no-guide" });
  });

  test("the spend survives a restart, so a consumed guide cannot be replayed", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    await m.store.exchange(token, async () => ({ ok: false as const, reason: "device-limit" }));
    const restarted = new OpenGuideStore(m.io, () => 1_001, (n) => Buffer.alloc(n, 0x5a));
    const again = await restarted.exchange(token, async () => ({ ok: true as const, value: "ok" }));
    expect(again).toEqual({ ok: false, source: "guide", reason: "no-guide" });
  });

  test("a removal failure is not ignored: the exchange fails before commit", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    m.io.remove = async () => {
      throw new Error("cannot remove");
    };
    let runs = 0;
    await expect(
      m.store.exchange(token, async () => {
        runs++;
        return { ok: true as const, value: "ok" };
      }),
    ).rejects.toThrow("cannot remove");
    expect(runs).toBe(0);
  });

  test("a removal that reports nothing removed is no-guide, and commits nothing", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    m.io.remove = async () => false;
    let runs = 0;
    const answer = await m.store.exchange(token, async () => {
      runs++;
      return { ok: true as const, value: "ok" };
    });
    expect(answer).toEqual({ ok: false, source: "guide", reason: "no-guide" });
    expect(runs).toBe(0);
  });

  test("a wrong token does not cancel the legitimate guide", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    const wrong = await m.store.exchange(mintOpenGuideToken(), async () => ({ ok: true as const, value: 1 }));
    expect(wrong).toEqual({ ok: false, source: "guide", reason: "bad-token" });
    expect(m.text()).not.toBeNull();
    expect(await m.store.exchange(token, async () => ({ ok: true as const, value: 1 }))).toEqual({
      ok: true,
      value: 1,
    });
  });

  test("an expired guide is deleted and never committed", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    m.advance(OPEN_GUIDE_TTL_MS);
    let runs = 0;
    const answer = await m.store.exchange(token, async () => {
      runs++;
      return { ok: true as const, value: 1 };
    });
    expect(answer).toEqual({ ok: false, source: "guide", reason: "expired" });
    expect(runs).toBe(0);
    expect(m.text()).toBeNull();
  });

  test("two tabs racing one guide commit once", async () => {
    const m = memoryStore();
    const token = await m.store.mint();
    let runs = 0;
    const commit = async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true as const, value: runs };
    };
    const [a, b] = await Promise.all([m.store.exchange(token, commit), m.store.exchange(token, commit)]);
    expect(runs).toBe(1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok && r.source === "guide" && r.reason === "no-guide")).toHaveLength(1);
  });
});

describe("the guide file", () => {
  test("writes 0600, reads back, and leaves no temp file", async () => {
    const dir = await tempDir();
    const io = fileOpenGuideIo(dir);
    await io.write(JSON.stringify(newOpenGuide(mintOpenGuideToken(), 1_000)));
    const path = join(dir, OPEN_GUIDE_FILENAME);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await io.read()).toContain("tokenHash");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a missing file is null; a damaged one is invalid", async () => {
    const dir = await tempDir();
    expect(await fileOpenGuideIo(dir).read()).toBeNull();
    await writeFile(join(dir, OPEN_GUIDE_FILENAME), "{", { mode: 0o600 });
    await chmod(join(dir, OPEN_GUIDE_FILENAME), 0o600);
    expect(readOpenGuideState(await fileOpenGuideIo(dir).read())).toMatchObject({ kind: "invalid" });
  });

  test("world-readable, symlinked and oversized files are refused", async () => {
    const dir = await tempDir();
    const path = join(dir, OPEN_GUIDE_FILENAME);
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(fileOpenGuideIo(dir).read()).rejects.toThrow(/group or others/);
    await chmod(path, 0o600);
    const target = join(dir, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await expect(fileOpenGuideIo(dir).read()).rejects.toThrow(/symbolic link/);
    await rm(path);
    await writeFile(path, "x".repeat(OPEN_GUIDE_FILE_MAX_BYTES + 1), { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(fileOpenGuideIo(dir).read()).rejects.toThrow(/larger than/);
  });

  test("minting writes a fresh hash, not the token", async () => {
    const dir = await tempDir();
    const store = new OpenGuideStore(fileOpenGuideIo(dir), () => 5_000, (n) => Buffer.alloc(n, 0x33));
    const token = await store.mint();
    const text = await readFile(join(dir, OPEN_GUIDE_FILENAME), "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toMatchObject({ version: 1, expiresAt: 5_000 + OPEN_GUIDE_TTL_MS });
  });
});
