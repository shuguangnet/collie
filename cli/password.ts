import {
  createPasswordVerifier,
  filePasswordIo,
  PASSWORD_FILENAME,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyProblem,
  readPasswordState,
  serializePasswordVerifier,
  type PasswordIo,
  type PasswordState,
} from "../bridge/password.ts";
import { loadContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";

// `collie password set | status | clear` — the ONLY writer of the shared web password (ADR 0133).
//
// The password never arrives through argv or the environment: a shell history and a process listing
// are both readable by other processes, and a password typed as an argument is a password already
// leaked. `set` either reads a hidden TTY line twice (the interactive case) or the whole of stdin
// (`--stdin`, for automation that already has a secure channel). Nothing this module prints is the
// password, its verifier, its salt or its KDF output.

/** The `password` sub-verbs, in the order the usage block prints them. */
export const PASSWORD_SUBCOMMANDS = ["set", "status", "clear"] as const;

export interface PasswordDeps {
  ctx: { readonly stateDir: string };
  io: Io;
  /** The verifier file. Production is `filePasswordIo(ctx.stateDir)`; tests inject one. */
  passwordIo?: PasswordIo;
  /** Read one line without echo. Production is {@link readHiddenFromTty}. */
  promptHidden?: (label: string) => Promise<string>;
  /** Read all of stdin. Production is {@link readStdinText}. */
  readStdin?: () => Promise<string>;
  /** Injected so a test pins the salt; production leaves it. */
  random?: (n: number) => Buffer;
}

/** Build the production seams from the resolved context. */
export function passwordDeps(io: Io): PasswordDeps {
  const ctx = loadContext(io.err);
  return {
    ctx,
    io,
    passwordIo: filePasswordIo(ctx.stateDir),
    promptHidden: readHiddenFromTty,
    readStdin: readStdinText,
  };
}

/** A prompt failure whose message is safe to print: it never contains what was typed. */
export class PasswordPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPromptError";
  }
}

/** The slice of a raw-mode input stream the prompt needs; `process.stdin` in production. */
export interface HiddenInput {
  isTTY?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "data", listener: (chunk: string) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  pause(): void;
}

/**
 * Read a hidden line from the terminal. Raw mode, no echo, backspace deletes, Ctrl-C cancels. The
 * prompt goes to stderr so a piped stdout stays machine-readable.
 *
 * The value is bounded HERE, at {@link PASSWORD_MAX_LENGTH} code points: a paste is one chunk, and
 * the process must not accumulate a multi-megabyte string before the policy check sees it. Every
 * rejection is a {@link PasswordPromptError} with a fixed message, so the caller can print it
 * without ever echoing the password. The `input` seam exists so a test can drive a paste or a
 * stream failure without owning the real terminal.
 */
export function readHiddenFromTty(label: string, input: HiddenInput = process.stdin): Promise<string> {
  if (input.isTTY !== true) {
    return Promise.reject(new PasswordPromptError("stdin is not a terminal; use `collie password set --stdin`"));
  }
  process.stderr.write(label);
  try {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
  } catch {
    process.stderr.write("\n");
    return Promise.reject(new PasswordPromptError("could not read the terminal"));
  }
  return new Promise<string>((resolve, reject) => {
    let value = "";
    function cleanup(): void {
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode(false);
      input.pause();
    }
    function fail(message: string): void {
      cleanup();
      process.stderr.write("\n");
      reject(new PasswordPromptError(message));
    }
    function onError(): void {
      fail("could not read the terminal");
    }
    let escape: "none" | "start" | "sequence" = "none";
    function onData(chunk: string): void {
      for (const ch of chunk) {
        // A terminal sends an escape SEQUENCE for arrows, Home/End and function keys. The ESC itself
        // is below space, but its `[` and `A` are not: skip the whole sequence rather than appending
        // stray bytes to a password.
        if (escape === "start") {
          escape = ch === "[" || ch === "O" ? "sequence" : "none";
          continue;
        }
        if (escape === "sequence") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (ch === "\u001b") {
          escape = "start";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          fail("cancelled");
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (ch >= " ") {
          // Count code points, not UTF-16 units: an astral character is one character here and may
          // be four UTF-8 bytes later, which the policy check bounds separately.
          if (Array.from(value).length >= PASSWORD_MAX_LENGTH) {
            fail(`the password must be at most ${PASSWORD_MAX_LENGTH} characters`);
            return;
          }
          value += ch;
        }
      }
    }
    input.once("error", onError);
    input.on("data", onData);
  });
}

/** All of stdin is bounded: `--stdin` is a password, not a file upload. */
export const PASSWORD_STDIN_MAX_BYTES = 8 * 1024;

/** Read all of stdin as UTF-8, refusing to buffer more than {@link PASSWORD_STDIN_MAX_BYTES}. */
export async function readStdinText(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    total += bytes.byteLength;
    if (total > PASSWORD_STDIN_MAX_BYTES) throw new Error("stdin is too large for a password");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One trailing newline is a line terminator, not part of the password. */
function withoutTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

async function stateOf(io: PasswordIo): Promise<PasswordState> {
  try {
    return readPasswordState(await io.read());
  } catch (err) {
    return {
      kind: "invalid",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function describe(state: PasswordState): string {
  if (state.kind === "absent") return "access password: not configured";
  if (state.kind === "invalid") return `access password: unavailable (${state.reason})`;
  return "access password: configured";
}

const USAGE =
  "usage: collie password set [--stdin] [--force] | collie password status | collie password clear";

function usage(io: Io): number {
  io.err(USAGE);
  return EXIT.USAGE;
}

/**
 * `set`: read the password from a hidden TTY prompt (twice) or from stdin, check the policy, hash it
 * with a fresh salt, and install only the verifier.
 *
 * A file that exists but is not a supported verifier is REFUSED, not overwritten: a damaged store
 * is the one moment where guessing that the operator meant to replace it would destroy the only
 * remaining evidence. `--force` is the explicit override; `clear` is the other.
 */
async function cmdSet(deps: PasswordDeps, args: readonly string[]): Promise<number> {
  let fromStdin = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--stdin") fromStdin = true;
    else if (arg === "--force") force = true;
    else return usage(deps.io);
  }
  const io = deps.passwordIo ?? filePasswordIo(deps.ctx.stateDir);
  const state = await stateOf(io);
  if (state.kind === "invalid" && !force) {
    deps.io.err(
      `${PASSWORD_FILENAME} exists but is not a usable verifier (${state.reason}). ` +
        "Not overwriting it. Fix or remove it, or pass --force to replace it deliberately.",
    );
    return EXIT.FAIL;
  }

  let password: string;
  if (fromStdin) {
    if (deps.readStdin === undefined) {
      deps.io.err("this build cannot read stdin");
      return EXIT.FAIL;
    }
    try {
      password = withoutTrailingNewline(await deps.readStdin());
    } catch {
      // A stream error's message is not ours and could echo data; the operator gets one fixed line.
      deps.io.err("could not read stdin; nothing was written");
      return EXIT.FAIL;
    }
  } else {
    if (deps.promptHidden === undefined) {
      deps.io.err("this build cannot read a terminal; use `collie password set --stdin`");
      return EXIT.FAIL;
    }
    try {
      password = await deps.promptHidden("Password: ");
      const again = await deps.promptHidden("Again: ");
      if (password !== again) {
        deps.io.err("the two passwords do not match; nothing was written");
        return EXIT.FAIL;
      }
    } catch (err) {
      // Only our own prompt errors are printable. Anything else (a stream fault from an injected
      // seam, a library) gets one fixed sentence, never its message.
      deps.io.err(
        err instanceof PasswordPromptError
          ? `${err.message}; nothing was written`
          : "could not read the password from the terminal; nothing was written",
      );
      return EXIT.FAIL;
    }
  }

  if (password === "") {
    deps.io.err("the password is empty; nothing was written");
    return EXIT.FAIL;
  }
  const problem = passwordPolicyProblem(password);
  if (problem !== null) {
    deps.io.err(`${problem}; nothing was written`);
    return EXIT.FAIL;
  }

  let verifier;
  try {
    verifier = await createPasswordVerifier(password, deps.random);
  } catch (err) {
    deps.io.err(`could not hash the password: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  try {
    await io.write(serializePasswordVerifier(verifier));
  } catch (err) {
    deps.io.err(`could not write ${PASSWORD_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(
    "access password set. The web sign-in form is available now; devices already signed in keep their tokens.",
  );
  return EXIT.OK;
}

async function cmdStatus(deps: PasswordDeps): Promise<number> {
  const io = deps.passwordIo ?? filePasswordIo(deps.ctx.stateDir);
  const state = await stateOf(io);
  deps.io.out(describe(state));
  return state.kind === "invalid" ? EXIT.FAIL : EXIT.OK;
}

async function cmdClear(deps: PasswordDeps): Promise<number> {
  const io = deps.passwordIo ?? filePasswordIo(deps.ctx.stateDir);
  try {
    await io.remove();
  } catch (err) {
    deps.io.err(`could not remove ${PASSWORD_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(
    "access password cleared. Password sign-in is off; devices already signed in remain valid — revoke each one to end it.",
  );
  return EXIT.OK;
}

/** `collie password …`. The first argument is the sub-verb; none prints the usage block. */
export async function cmdPassword(deps: PasswordDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "set") return cmdSet(deps, rest);
  if (sub === "status") return rest.length === 0 ? cmdStatus(deps) : usage(deps.io);
  if (sub === "clear") return rest.length === 0 ? cmdClear(deps) : usage(deps.io);
  return usage(deps.io);
}

/** The maximum byte length a password may have, re-exported for the tests and the docs. */
export const PASSWORD_BYTES_LIMIT = PASSWORD_MAX_BYTES;
/** The shortest accepted password, re-exported for the tests and the docs. */
export const PASSWORD_MIN = PASSWORD_MIN_LENGTH;
