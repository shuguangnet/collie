import { spawn } from "node:child_process";

import { HOST } from "../bridge/host.ts";

import {
  fileOpenGuideIo,
  isOpenGuideToken,
  OPEN_GUIDE_FRAGMENT,
  OpenGuideStore,
  type OpenGuideIo,
} from "../bridge/open-guide.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";

// `collie open` — the host's own browser, one command, no code to type (ADR 0133).
//
// The guide is minted HERE, in the terminal that already proves the caller is the operator, and
// travels only in the URL FRAGMENT. A fragment is not sent in the request line, so a front door's
// access log never sees it; the page removes it before React Router starts and spends it once. The
// URL is never printed: the terminal's scrollback is another place a credential should not linger.

export interface OpenDeps {
  ctx: Pick<CliContext, "port" | "basePath" | "stateDir">;
  io: Io;
  /** The guide file. Production is `fileOpenGuideIo(ctx.stateDir)`; tests inject one. */
  guideIo?: OpenGuideIo;
  /** Open one URL with the platform's handler. Production is {@link openWithPlatform}. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Injected so a test pins the guide token; production leaves it. */
  random?: (n: number) => Buffer;
}

/** Build the production seams from the resolved context. */
export function openDeps(ctx: CliContext, io: Io): OpenDeps {
  return { ctx, io, guideIo: fileOpenGuideIo(ctx.stateDir), openUrl: openWithPlatform };
}

/**
 * The mount to append to the loopback origin, or null when the value cannot be trusted in a URL.
 * `normaliseBasePath` has already made this `/<segment>/` or `/`; this is the second check at the
 * point a string becomes a URL, so a hand-edited value with `?`, `#` or whitespace is refused rather
 * than changing where the guide lands. The trailing slash is kept: it is the URL the app is mounted
 * at, and the browser never has to redirect (a redirect is another place a fragment can be dropped).
 */
export function openBasePath(basePath: string): string | null {
  if (!basePath.startsWith("/") || !basePath.endsWith("/")) return null;
  if (/[\s?#]/.test(basePath)) return null;
  if (basePath !== "/" && !/^\/[A-Za-z0-9._~/-]*\/$/.test(basePath)) return null;
  if (basePath.includes("//")) return null;
  const segments = basePath.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return basePath === "/" ? "/" : basePath;
}

/** The strict loopback URL for `token`, or null for a port/mount this command will not open. */
export function openUrlFor(
  port: number,
  basePath: string,
  token: string,
): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!isOpenGuideToken(token)) return null;
  const mount = openBasePath(basePath);
  if (mount === null) return null;
  // 127.0.0.1, never a hostname and never the tailnet name: `collie open` is the host's own browser.
  return `http://127.0.0.1:${port}${mount}#${OPEN_GUIDE_FRAGMENT}=${token}`;
}

/**
 * Open `url` through the platform's handler, and REPORT whether the launcher actually started.
 * A missing handler emits `error` and a launcher that refuses exits non-zero; both reject instead of
 * the command printing "Opened" over a browser that never appeared. A launcher that is merely slow
 * to exit (some `xdg-open` implementations wait for the browser) is treated as started after a bound.
 */
export function openWithPlatform(url: string): Promise<void> {
  // No shell on any platform. Windows uses the URL handler directly (`rundll32 url.dll`), never
  // `cmd /c start`: a URL is data, and `cmd` would interpret `&`, `%` and friends as syntax.
  const [command, args] =
    HOST.platform === "darwin"
      ? (["open", [url]] as const)
      : HOST.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : (["xdg-open", [url]] as const);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true, shell: false });
    timer = setTimeout(() => finish(resolve), 10_000);
    child.once("error", (err) => finish(() => reject(err)));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(signal === null ? `launcher exited ${code ?? "?"}` : `launcher stopped by ${signal}`)));
    });
  });
}

/** `collie open`. Any argument is an unknown URL and is refused before a guide is minted. */
export async function cmdOpen(deps: OpenDeps, args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    deps.io.err("usage: collie open");
    deps.io.err("This command opens this machine's own Collie; it takes no URL or instance argument.");
    return EXIT.USAGE;
  }
  const store = new OpenGuideStore(deps.guideIo ?? fileOpenGuideIo(deps.ctx.stateDir), Date.now, deps.random);
  let token: string;
  try {
    token = await store.mint();
  } catch (err) {
    deps.io.err(`could not mint a one-time link: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  const url = openUrlFor(deps.ctx.port, deps.ctx.basePath, token);
  if (url === null) {
    deps.io.err(
      `refusing to open: port ${deps.ctx.port} or base path ${JSON.stringify(deps.ctx.basePath)} is not a safe loopback address`,
    );
    return EXIT.FAIL;
  }
  try {
    await (deps.openUrl ?? openWithPlatform)(url);
  } catch (err) {
    deps.io.err(`could not open a browser: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  // Deliberately no URL, no token and no fragment: this line may sit in scrollback or a paste.
  deps.io.out("Opened Collie in this machine's browser. The one-time link expires in two minutes.");
  return EXIT.OK;
}
