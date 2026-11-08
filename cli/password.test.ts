import { describe, expect, test } from "bun:test";

import {
  PASSWORD_FILENAME,
  readPasswordState,
  verifyPassword,
  type PasswordIo,
} from "../bridge/password.ts";
import { capture } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdPassword,
  PasswordPromptError,
  readHiddenFromTty,
  type HiddenInput,
  type PasswordDeps,
} from "./password.ts";

// `collie password set | status | clear` (ADR 0133). Nothing here touches a real terminal or the
// real state dir: the verifier store, both readers and the salt are seams, and the assertions are
// about what reaches the file and what never reaches stdout/stderr.

const PASSWORD = "correct horse battery";

function memoryPasswordIo(): PasswordIo & { text: () => string | null } {
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

type TestPasswordDeps = PasswordDeps & {
  io: ReturnType<typeof capture>;
  passwordIo: PasswordIo & { text: () => string | null };
};

function deps(over: Partial<PasswordDeps> = {}): TestPasswordDeps {
  const io = capture();
  // SAFETY: the fixture supplies the extended fields, and every override is type-compatible with the
  // seam it replaces; the extension only adds the test-only readers below.
  return {
    ctx: { stateDir: "/state" },
    io,
    passwordIo: memoryPasswordIo(),
    readStdin: async () => PASSWORD,
    promptHidden: async () => PASSWORD,
    random: (n) => Buffer.alloc(n, 0x22),
    ...over,
  } as TestPasswordDeps;
}

function storedVerifier(d: TestPasswordDeps) {
  const text = d.passwordIo.text();
  return text === null ? null : readPasswordState(text);
}

describe("collie password set", () => {
  test("stores a verifier from --stdin, never the password or the verifier in output", async () => {
    const d = deps();
    expect(await cmdPassword(d, ["set", "--stdin"])).toBe(EXIT.OK);
    const state = storedVerifier(d);
    expect(state?.kind).toBe("ok");
    if (state?.kind !== "ok") throw new Error("expected a verifier");
    expect(await verifyPassword(state.verifier, PASSWORD)).toBe(true);
    expect(await verifyPassword(state.verifier, `${PASSWORD}!`)).toBe(false);
    const file = d.passwordIo!.text()!;
    expect(file).not.toContain(PASSWORD);
    const printed = [...d.io.stdout, ...d.io.stderr].join("\n");
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(state.verifier.verifier);
  });

  test("prompts twice and refuses a mismatch without writing", async () => {
    const answers = ["one long password", "one long passworD"];
    const d = deps({ promptHidden: async () => answers.shift()! });
    expect(await cmdPassword(d, ["set"])).toBe(EXIT.FAIL);
    expect(d.passwordIo!.text()).toBeNull();
    expect(d.io.stderr.join("\n")).toContain("do not match");
  });

  test("refuses a password outside the policy", async () => {
    const d = deps({ readStdin: async () => "short" });
    expect(await cmdPassword(d, ["set", "--stdin"])).toBe(EXIT.FAIL);
    expect(d.passwordIo!.text()).toBeNull();
    expect(d.io.stderr.join("\n")).toContain("at least");
  });

  test("does not overwrite a damaged verifier unless --force is given", async () => {
    const d = deps();
    await d.passwordIo!.write("{ not a verifier");
    expect(await cmdPassword(d, ["set", "--stdin"])).toBe(EXIT.FAIL);
    expect(d.passwordIo!.text()).toBe("{ not a verifier");
    expect(d.io.stderr.join("\n")).toContain(PASSWORD_FILENAME);
    expect(await cmdPassword(d, ["set", "--stdin", "--force"])).toBe(EXIT.OK);
    expect(storedVerifier(d)).toMatchObject({ kind: "ok" });
  });

  test("a stdin failure prints one fixed line and nothing the stream said", async () => {
    const d = deps({
      readStdin: async () => {
        throw new Error("secret-looking stream failure");
      },
    });
    expect(await cmdPassword(d, ["set", "--stdin"])).toBe(EXIT.FAIL);
    expect(d.passwordIo!.text()).toBeNull();
    expect(d.io.stderr).toEqual(["could not read stdin; nothing was written"]);
    for (const line of d.io.stderr) expect(line).not.toContain("secret-looking");
  });

  test("an unexpected prompt failure is generic; our own cancel message is kept", async () => {
    const unexpected = deps({
      promptHidden: async () => {
        throw new Error("typed secret leaked into an error");
      },
    });
    expect(await cmdPassword(unexpected, ["set"])).toBe(EXIT.FAIL);
    expect(unexpected.io.stderr.join("\n")).not.toContain("typed secret");
    expect(unexpected.io.stderr.join("\n")).toContain("could not read the password from the terminal");

    const cancelled = deps({
      promptHidden: async () => {
        throw new PasswordPromptError("cancelled");
      },
    });
    expect(await cmdPassword(cancelled, ["set"])).toBe(EXIT.FAIL);
    expect(cancelled.io.stderr.join("\n")).toContain("cancelled; nothing was written");
  });
});

describe("collie password status/clear", () => {
  test("status distinguishes absent, configured and damaged", async () => {
    const absent = deps();
    expect(await cmdPassword(absent, ["status"])).toBe(EXIT.OK);
    expect(absent.io.stdout.join("\n")).toContain("not configured");

    const configured = deps();
    await cmdPassword(configured, ["set", "--stdin"]);
    const status = deps({ passwordIo: configured.passwordIo });
    expect(await cmdPassword(status, ["status"])).toBe(EXIT.OK);
    expect(status.io.stdout.join("\n")).toContain("configured");

    const damaged = deps();
    await damaged.passwordIo!.write("{");
    expect(await cmdPassword(damaged, ["status"])).toBe(EXIT.FAIL);
    expect(damaged.io.stdout.join("\n")).toContain("unavailable");
  });

  test("clear removes the verifier and says signed-in devices stay", async () => {
    const d = deps();
    await cmdPassword(d, ["set", "--stdin"]);
    expect(await cmdPassword(d, ["clear"])).toBe(EXIT.OK);
    expect(d.passwordIo!.text()).toBeNull();
    expect(d.io.stdout.join("\n")).toContain("devices already signed in remain valid");
  });

  test("a bare or unknown sub-verb prints usage and exits 2", async () => {
    for (const argv of [[], ["nonsense"], ["status", "extra"]]) {
      const d = deps();
      expect(await cmdPassword(d, argv)).toBe(EXIT.USAGE);
      expect(d.io.stderr.join("\n")).toContain("usage: collie password");
    }
  });
});

describe("readHiddenFromTty", () => {
  function fakeInput(isTTY = true) {
    let data: ((chunk: string) => void) | undefined;
    let error: ((err: Error) => void) | undefined;
    const raw: boolean[] = [];
    let paused = 0;
    const input: HiddenInput = {
      isTTY,
      setRawMode: (mode) => {
        raw.push(mode);
      },
      resume: () => undefined,
      setEncoding: () => undefined,
      on: (event, listener) => {
        if (event === "data") data = listener;
        return input;
      },
      once: (event, listener) => {
        if (event === "error") error = listener;
        return input;
      },
      off: (event, listener) => {
        if (event === "data" && data === listener) data = undefined;
        if (event === "error" && error === listener) error = undefined;
        return input;
      },
      pause: () => {
        paused++;
      },
    };
    return {
      input,
      raw,
      paused: () => paused,
      emit: (chunk: string) => data?.(chunk),
      fail: (err: Error) => error?.(err),
    };
  }

  test("accepts a line, applies backspace, and restores the terminal", async () => {
    const fake = fakeInput();
    const pending = readHiddenFromTty("", fake.input);
    fake.emit("abc\u007f\r");
    expect(await pending).toBe("ab");
    expect(fake.raw).toEqual([true, false]);
    expect(fake.paused()).toBe(1);
  });

  test("arrow and function-key escape sequences do not enter the hidden password, even across chunks", async () => {
    const fake = fakeInput();
    const pending = readHiddenFromTty("", fake.input);
    fake.emit("secret\u001b");
    fake.emit("[A\u001b[3~\u001bOP");
    fake.emit("-value\r");
    expect(await pending).toBe("secret-value");
    expect(fake.raw).toEqual([true, false]);
  });

  test("bounds the line at 256 code points, astral characters included", async () => {
    const ok = fakeInput();
    const accepted = readHiddenFromTty("", ok.input);
    ok.emit(`${"😀".repeat(256)}\r`);
    expect(await accepted).toHaveLength(512); // 256 astral code points, 512 UTF-16 units.

    const tooLong = fakeInput();
    const rejected = readHiddenFromTty("", tooLong.input);
    tooLong.emit("😀".repeat(257));
    await expect(rejected).rejects.toThrow("at most 256 characters");
    expect(tooLong.raw).toEqual([true, false]);
  });

  test("Ctrl-C cancels and a stream error rejects with the same safe sentence", async () => {
    const cancelled = fakeInput();
    const pending = readHiddenFromTty("", cancelled.input);
    cancelled.emit("\u0003");
    await expect(pending).rejects.toThrow("cancelled");

    const broken = fakeInput();
    const failed = readHiddenFromTty("", broken.input);
    broken.fail(new Error("underlying terminal detail"));
    await expect(failed).rejects.toThrow("could not read the terminal");
  });

  test("a non-terminal stdin is refused before raw mode", async () => {
    const fake = fakeInput(false);
    await expect(readHiddenFromTty("", fake.input)).rejects.toThrow("not a terminal");
    expect(fake.raw).toEqual([]);
  });
});
