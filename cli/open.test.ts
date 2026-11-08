import { describe, expect, test } from "bun:test";

import {
  isOpenGuideToken,
  OPEN_GUIDE_FRAGMENT,
  type OpenGuideIo,
} from "../bridge/open-guide.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdOpen, openBasePath, openUrlFor, type OpenDeps } from "./open.ts";

// `collie open` (ADR 0133). The URL is the whole credential path: a guide in the FRAGMENT, on
// 127.0.0.1 only, and no argument can redirect it. These tests pin the pure address rules and then
// the verb's two observable halves — what it opens, and what it refuses to say.

const TOKEN = Buffer.alloc(32, 0x11).toString("base64url");

function memoryGuideIo(): OpenGuideIo & { text: () => string | null } {
  let text: string | null = null;
  return {
    read: async () => text,
    write: async (next) => {
      text = next;
    },
    remove: async () => {
      const had = text !== null;
      text = null;
      return had;
    },
    text: () => text,
  };
}

type TestOpenDeps = OpenDeps & {
  io: ReturnType<typeof capture>;
  guideIo: OpenGuideIo & { text: () => string | null };
};

function deps(over: Partial<OpenDeps> = {}): TestOpenDeps {
  const io = capture();
  // SAFETY: the fixture supplies the extended fields, and every override is type-compatible with the
  // seam it replaces; the extension only adds the test-only readers below.
  return {
    ctx: { port: 8787, basePath: "/collie/", stateDir: "/state" },
    io,
    guideIo: memoryGuideIo(),
    random: (n) => Buffer.alloc(n, 0x11),
    ...over,
  } as TestOpenDeps;
}

describe("openBasePath", () => {
  test("accepts the normalised root and one-segment mounts, keeping the trailing slash", () => {
    expect(openBasePath("/")).toBe("/");
    expect(openBasePath("/collie/")).toBe("/collie/");
    expect(openBasePath("/a/b/")).toBe("/a/b/");
    expect(openBasePath("/a_b-c.d/")).toBe("/a_b-c.d/");
  });

  test("refuses a value that could move the guide somewhere else", () => {
    for (const bad of [
      "collie/",
      "/collie",
      "//",
      "/a//b/",
      "/a/./b/",
      "/a/../b/",
      "/../",
      "/a?b/",
      "/a#b/",
      "/a b/",
      "/a%2e%2e/",
    ]) {
      expect(openBasePath(bad)).toBeNull();
    }
  });

  test("the URL is strict loopback, and the guide rides only the fragment", () => {
    expect(openUrlFor(8787, "/collie/", TOKEN)).toBe(
      `http://127.0.0.1:8787/collie/#${OPEN_GUIDE_FRAGMENT}=${TOKEN}`,
    );
    expect(openUrlFor(8787, "/", TOKEN)).toBe(`http://127.0.0.1:8787/#${OPEN_GUIDE_FRAGMENT}=${TOKEN}`);
    const url = new URL(openUrlFor(8787, "/collie/", TOKEN)!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${OPEN_GUIDE_FRAGMENT}=${TOKEN}`);
  });

  test("refuses a bad port, token or mount instead of opening a partial URL", () => {
    expect(openUrlFor(0, "/", TOKEN)).toBeNull();
    expect(openUrlFor(65_536, "/", TOKEN)).toBeNull();
    expect(openUrlFor(1.5, "/", TOKEN)).toBeNull();
    expect(openUrlFor(8787, "/", "short")).toBeNull();
    expect(openUrlFor(8787, "/a/../b/", TOKEN)).toBeNull();
  });
});

describe("cmdOpen", () => {
  test("mints once, opens the exact loopback URL, and never prints the token", async () => {
    const d = deps();
    const opened: string[] = [];
    d.openUrl = async (url) => {
      opened.push(url);
    };
    expect(await cmdOpen(d, [])).toBe(EXIT.OK);
    expect(opened).toEqual([`http://127.0.0.1:8787/collie/#${OPEN_GUIDE_FRAGMENT}=${TOKEN}`]);
    expect(isOpenGuideToken(TOKEN)).toBe(true);
    // The file holds the hash, never the clear token.
    expect(d.guideIo!.text()).not.toBeNull();
    expect(d.guideIo!.text()).not.toContain(TOKEN);
    const printed = [...d.io.stdout, ...d.io.stderr].join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("collie-open");
    expect(printed).not.toContain("http://");
  });

  test("takes no URL argument: nothing is minted and nothing opens", async () => {
    const d = deps();
    let opened = 0;
    d.openUrl = () => {
      opened++;
    };
    expect(await cmdOpen(d, ["https://elsewhere.example"])).toBe(EXIT.USAGE);
    expect(opened).toBe(0);
    expect(d.guideIo!.text()).toBeNull();
    expect(d.io.stderr.join("\n")).toContain("usage: collie open");
  });

  test("an unsafe base path is refused before a browser is spawned", async () => {
    const d = deps();
    d.ctx = { port: 8787, basePath: "/a/../b/", stateDir: "/state" };
    let opened = 0;
    d.openUrl = () => {
      opened++;
    };
    expect(await cmdOpen(d, [])).toBe(EXIT.FAIL);
    expect(opened).toBe(0);
    expect(d.io.stderr.join("\n")).toContain("refusing to open");
    expect(d.io.stdout).toEqual([]);
  });

  test("a launcher that fails is reported, not printed over as success", async () => {
    const d = deps();
    d.openUrl = async () => {
      throw new Error("no handler");
    };
    expect(await cmdOpen(d, [])).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("could not open a browser");
    expect(d.io.stdout).toEqual([]);
  });
});
