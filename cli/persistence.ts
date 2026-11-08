// Persistent-runtime diagnosis: a pure judgement over injectable, READ-ONLY facts.
//
// `collie doctor --only persistence` and `collie status --json` both read this module, and the remote
// leg of `collie crew add --persistent` runs that same verb over ssh. There is one judgement, so the
// three can never disagree about whether a machine survives a logout or a reboot.
//
// ── WHAT IS PROMISED, AND WHAT IS NOT ────────────────────────────────────────
// Linux: a `systemd --user` unit that belongs to this user, whose LOADED fragment is this install's
// own unit, whose ExecStart runs this install and this instance, is enabled persistently (not
// `enabled-runtime`), and is active, plus linger. With linger on, the user manager survives the last
// logout; without it, the service is only as durable as the login session. `loginctl enable-linger`
// is a one-time operator action and this module never runs it — it only reports what it observed.
//
// macOS: a launchd job Collie generated (or an externally managed job of the same label) that is
// loaded and running, whose plist is this install's own and carries `RunAtLoad` + `KeepAlive`, is not
// disabled by a launchd override, and whose program is this install and instance. That is an
// AFTER-LOGIN guarantee: launchd's GUI domain exists only with a console login, so this is never a
// promise about a Mac that rebooted to a login window. An externally managed job is recognised
// read-only and never replaced.
//
// Windows and any other platform: not verified here. Task Scheduler keeps its existing behaviour and
// `--persistent` refuses to call it ready rather than inventing a guarantee.
//
// Herdr is a separate condition. A bridge can be up while the multiplexer is stopped, and the honest
// answer then is "Collie is online, the mux is not" — not a re-pairing prompt and not a green
// persistent badge.
//
// Every unknown is `null`, never `false` and never `true`: a probe that did not answer is not
// evidence that the thing is absent.

import type { Host } from "../bridge/host.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonBoolean, asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import { herdrActionCommand, type CliContext } from "./context.ts";
import { bad, ok, skipped, type Finding } from "./finding.ts";
import type { Tier } from "./lifecycle.ts";
import type { Exec, Files } from "./sys.ts";
import { agentFilePath, agentLabel, collieBinary, unitFilePath, unitName } from "./unit.ts";

/** What a persistent deployment actually guarantees, in the operator's terms. */
export type PersistenceGuarantee =
  | "unattended"
  | "after-login"
  | "unsupervised"
  | "unsupported"
  | "unknown";

/** The install shape, used only to name a command the operator can actually run there. */
export type PersistenceInstallKind =
  | "linked-clone"
  | "detached-checkout"
  | "binary"
  | "packaged"
  | "unknown";

/** Does the loaded supervisor belong to THIS install and instance? */
export type PersistenceIdentity = "current" | "other" | "unknown";

/** Does the loaded supervisor survive a logout/reboot, or only this runtime/login? */
export type PersistenceDurability = "persistent" | "runtime-only" | "transient" | "unknown";

/** Why a persistent check did or did not pass. Stable identifiers for `--json` readers. */
export type PersistenceReason =
  | "ready"
  | "unsupported-platform"
  | "windows-unchanged"
  | "no-systemd"
  | "service-file-missing"
  | "service-file-foreign"
  | "service-file-unreadable"
  | "service-identity-other"
  | "service-identity-unknown"
  | "service-runtime-only"
  | "service-not-durable"
  | "service-disabled-override"
  | "service-disabled"
  | "service-inactive"
  | "linger-disabled"
  | "linger-unknown"
  | "launchd-not-loaded"
  | "launchd-not-running"
  | "unsupervised"
  | "mux-unreachable"
  | "mux-unknown"
  | "unreadable";

/** One machine's supervision and login facts. `null` means the probe did not answer. */
export interface PersistenceFacts {
  readonly platform: "linux" | "darwin" | "win32" | "other";
  readonly tier: Tier;
  /** How this Collie was installed; `unknown` when the probe could not tell. */
  readonly installKind: PersistenceInstallKind;
  /** The instance suffix, or null for the unsuffixed instance. */
  readonly instance: string | null;
  /** The service definition: this user's own, somebody else's, absent, or unreadable. */
  readonly serviceFile: "owned" | "foreign" | "absent" | "unknown";
  /** Does the ACTUAL loaded unit/job run this install and this instance? */
  readonly identity: PersistenceIdentity;
  /** Does the ACTUAL loaded unit/job survive a logout/reboot? */
  readonly durability: PersistenceDurability;
  readonly serviceEnabled: boolean | null;
  readonly serviceActive: boolean | null;
  /** `loginctl`'s `Linger=` answer. Linux only; `null` everywhere else and when unreadable. */
  readonly linger: boolean | null;
  /** The launchd domain that carries the job (`gui` or `user`), or null when it is not loaded. */
  readonly launchdDomain: "gui" | "user" | null;
  readonly muxName: string;
  /** Did the configured multiplexer answer a real request? `null` when nobody could ask. */
  readonly muxReachable: boolean | null;
}

/** The whole answer, as `doctor --only persistence --json` carries it under `data`. */
export interface PersistenceReport {
  readonly ready: boolean;
  readonly guarantee: PersistenceGuarantee;
  readonly platform: PersistenceFacts["platform"];
  readonly supervisionTier: Tier;
  readonly installKind: PersistenceInstallKind;
  readonly instance: string | null;
  readonly identity: PersistenceIdentity;
  readonly durability: PersistenceDurability;
  readonly serviceEnabled: boolean | null;
  readonly serviceActive: boolean | null;
  readonly loginRequirement: "none" | "after-login" | "unknown";
  readonly linger: boolean | null;
  readonly launchdDomain: "gui" | "user" | null;
  readonly muxName: string;
  readonly muxReachable: boolean | null;
  readonly reasons: readonly PersistenceReason[];
  readonly detail: string;
}

/** Where {@link probePersistence} reaches the world. All four are reads. */
export interface PersistenceProbeInput {
  readonly ctx: Pick<CliContext, "home" | "instance" | "env" | "root">;
  readonly exec: Exec;
  readonly files: Files;
  readonly host: Host;
  /** The uid the service must belong to. Injected so a test can pin one. */
  readonly uid: () => number;
  /** The login name `loginctl show-user` is asked about. */
  readonly user: string;
  /** `supervisionTier`, resolved by the caller (it is the same answer `start` acts on). */
  readonly tier: Tier;
  /** This Collie's install shape, resolved by the caller; unknown when it cannot be told. */
  readonly installKind?: PersistenceInstallKind;
  readonly mux: { readonly name: string; readonly reachable: boolean | null };
}

const ENABLED_TRUE = new Set(["enabled", "enabled-runtime"]);
const ENABLED_FALSE = new Set([
  "disabled",
  "masked",
  "masked-runtime",
  "static",
  "indirect",
  "linked",
  "linked-runtime",
  "generated",
  "transient",
  "not-found",
  "bad",
]);
const ACTIVE_TRUE = new Set(["active", "reloading"]);
const ACTIVE_FALSE = new Set(["inactive", "failed", "activating", "deactivating", "maintenance"]);

function platformOf(platform: NodeJS.Platform): PersistenceFacts["platform"] {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  return "other";
}

/** `systemctl is-enabled`/`is-active`'s word as a boolean, or null when it is not a word we know. */
function triState(text: string, yes: ReadonlySet<string>, no: ReadonlySet<string>): boolean | null {
  const word = text.trim().toLowerCase();
  if (yes.has(word)) return true;
  if (no.has(word)) return false;
  return null;
}

/** Whether `p` is this user's file. A file that exists but cannot be stat'd is `unknown`. */
function ownership(files: Files, path: string, uid: number): PersistenceFacts["serviceFile"] {
  if (!files.exists(path)) return "absent";
  const owner = files.ownerUid(path);
  if (owner === null) return "unknown";
  return owner === uid ? "owned" : "foreign";
}

/** Two paths name the same file after symlinks, falling back to the lexical answer. */
function samePath(files: Files, a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  const ra = files.realpath(a);
  const rb = files.realpath(b);
  if (ra !== null && rb !== null) return ra === rb;
  return a === b;
}

/**
 * Does a supervisor's argv run THIS install and THIS instance?
 *
 * The binary is compared against the running install's own path, and a binary install also accepts
 * the `current` symlink beside its `versions/` directory: both name the same install, and an update
 * flips `current` without rewriting the unit. A unit pointing at another root, another account's
 * install, or another instance is NOT this one.
 */
function runsThisInstall(
  input: Pick<PersistenceProbeInput, "ctx" | "files" | "host">,
  program: string,
  argv: readonly string[],
): boolean {
  if (program === "") return false;
  const expected = unitBinary(input);
  const installRoot = input.host.path.dirname(input.host.path.dirname(input.ctx.root));
  const underInstall = input.host.path.basename(input.host.path.dirname(input.ctx.root)) === "versions";
  const pathMatches =
    samePath(input.files, program, expected) ||
    (underInstall && samePath(input.files, program, input.host.path.join(installRoot, "current", "bin", input.host.path.basename(expected))));
  if (!pathMatches) return false;
  if (!argv.includes("_exec-bridge")) return false;
  const instance = input.ctx.instance;
  if (instance === null) return !argv.includes("--instance");
  const at = argv.indexOf("--instance");
  return at >= 0 && argv[at + 1] === instance;
}

/** The binary a supervisor for this context should run. */
function unitBinary(input: Pick<PersistenceProbeInput, "ctx" | "host">): string {
  return collieBinary(input.ctx.root, input.host);
}

/** `systemctl show`'s `ExecStart=` value: the program and its argv, or null when it is not readable. */
function unitExecStart(text: string): { program: string; argv: string[] } | null {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (line === undefined) return null;
  const program = /(?:^|\s)path=([^;]+);/.exec(line)?.[1]?.trim() ?? "";
  const argvText = /argv\[\]=([^;]+);/.exec(line)?.[1]?.trim() ?? "";
  if (program === "" || argvText === "") return null;
  return { program, argv: argvText.split(/\s+/).filter((word) => word !== "") };
}

/** The loaded unit's identity and durability, as one named answer. */
interface LoadedIdentity {
  readonly identity: PersistenceIdentity;
  readonly durability: PersistenceDurability;
}

/** The loaded unit's identity and durability, from `systemctl --user show`. */
function linuxIdentity(
  input: Pick<PersistenceProbeInput, "ctx" | "files" | "host">,
  show: { readonly found: boolean; readonly code: number; readonly stdout: string },
): LoadedIdentity {
  if (!show.found || show.code !== 0) return { identity: "unknown", durability: "unknown" };
  const loadState = /^LoadState=(.*)$/m.exec(show.stdout)?.[1]?.trim() ?? "";
  const fragment = /^FragmentPath=(.*)$/m.exec(show.stdout)?.[1]?.trim() ?? "";
  const enabledWord = /^UnitFileState=(.*)$/m.exec(show.stdout)?.[1]?.trim().toLowerCase() ?? "";
  const exec = unitExecStart(show.stdout);
  const expectedFile = unitFilePath(input.ctx.home, input.ctx.instance);
  const durability: PersistenceDurability =
    enabledWord === "enabled"
      ? "persistent"
      : enabledWord === "enabled-runtime"
        ? "runtime-only"
        : enabledWord === ""
          ? "unknown"
          : "transient";
  // A unit that is masked, not-found or otherwise not loaded has no supervisor to attribute: that is
  // UNKNOWN, not "somebody else's install". Only a loaded fragment that mismatches is `other`.
  if (loadState !== "loaded" || fragment === "" || exec === null) {
    return { identity: "unknown", durability };
  }
  const identity =
    samePath(input.files, fragment, expectedFile) &&
    runsThisInstall(input, exec.program, exec.argv)
      ? "current"
      : "other";
  return { identity, durability };
}

/** One `launchctl print` answer, reduced to what the identity check needs. */
interface LaunchdJob {
  readonly domain: "gui" | "user";
  readonly running: boolean;
  readonly path: string;
  readonly program: string;
  readonly argv: readonly string[];
}

/** `launchctl print <domain>/<uid>/<label>`'s answer, or null when it is not a job. */
function parseLaunchdJob(domain: "gui" | "user", text: string): LaunchdJob | null {
  const path = /^[ \t]*path = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const program = /^[ \t]*program = (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const argumentsBlock = /^[ \t]*arguments = \{\n([\s\S]*?)^[ \t]*\}/m.exec(text)?.[1] ?? "";
  const argv = argumentsBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (path === "" || (program === "" && argv.length === 0)) return null;
  return {
    domain,
    running: /^[ \t]*pid = \d+/m.test(text),
    path,
    program: program !== "" ? program : (argv[0] ?? ""),
    argv: program !== "" && argv[0] !== program ? [program, ...argv] : argv,
  };
}

/** The plist's `RunAtLoad`, `KeepAlive`, `Disabled`, `Label` and `ProgramArguments`. */
interface LaunchdPlist {
  readonly label: string;
  readonly runAtLoad: boolean;
  readonly keepAlive: boolean;
  readonly disabled: boolean | null;
  readonly program: string;
  readonly argv: readonly string[];
}

/** A minimal plist reader for the keys launchd needs; null when it is not a readable plist. */
function parseLaunchdPlist(text: string | null): LaunchdPlist | null {
  if (text === null || !text.includes("<plist")) return null;
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]?.trim() ?? "";
  const runAtLoad = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(text);
  const keepAliveDict = /<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  const keepAlive = /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(text) ||
    /<key>SuccessfulExit<\/key>\s*<false\s*\/>/.test(keepAliveDict);
  const disabled = /<key>Disabled<\/key>\s*<true\s*\/>/.test(text)
    ? true
    : /<key>Disabled<\/key>\s*<false\s*\/>/.test(text)
      ? false
      : null;
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const argv = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlUnescape(match[1] ?? ""));
  const program = argv[0] ?? "";
  return { label, runAtLoad, keepAlive, disabled, program, argv };
}

/** The five XML entities a plist value can carry. */
function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Is this label explicitly disabled in a launchd domain? `null` when the override cannot be read. */
function launchdDisabled(
  input: Pick<PersistenceProbeInput, "exec">,
  domain: "gui" | "user",
  uid: number,
  label: string,
): boolean | null {
  const asked = input.exec.capture("launchctl", ["print-disabled", `${domain}/${uid}`]);
  if (!asked.found || asked.code !== 0) return null;
  for (const match of asked.stdout.matchAll(/"([^"]+)"\s*=>\s*(true|false)/g)) {
    if (match[1] === label) return match[2] === "true";
  }
  return false;
}

/** The loaded job's identity, durability and loaded/enabled state. */
interface LaunchdLoaded extends LoadedIdentity {
  readonly serviceActive: boolean;
  readonly serviceEnabled: boolean;
}

/** The loaded job's identity and durability, from `launchctl print` plus the plist it names. */
function launchdFacts(
  input: Pick<PersistenceProbeInput, "ctx" | "exec" | "files" | "host">,
  job: LaunchdJob,
  uid: number,
): LaunchdLoaded {
  const label = agentLabel(input.ctx.instance);
  const expectedFile = agentFilePath(input.ctx.home, input.ctx.instance);
  const plist = parseLaunchdPlist(input.files.read(job.path));
  const disabled = launchdDisabled(input, job.domain, uid, label);
  const fileIsOurs = samePath(input.files, job.path, expectedFile);
  const labelMatches = plist === null ? false : plist.label === label;
  const program = plist !== null && plist.program !== "" ? plist.program : job.program;
  const argv = plist !== null && plist.argv.length > 0 ? plist.argv : job.argv;
  const sameProgram = plist === null || plist.program === "" || job.program === "" || plist.program === job.program;
  const identity =
    plist === null || !sameProgram || !labelMatches
      ? "unknown"
      : fileIsOurs && runsThisInstall(input, program, argv) && runsThisInstall(input, job.program, job.argv)
        ? "current"
        : "other";
  const durability: PersistenceDurability =
    plist === null
      ? "unknown"
      : disabled === true || plist.disabled === true
        ? "transient"
        : disabled === null
          ? "unknown"
          : plist.runAtLoad && plist.keepAlive
            ? "persistent"
            : "transient";
  return {
    identity,
    durability,
    serviceActive: job.running,
    serviceEnabled: disabled !== true && plist?.disabled !== true,
  };
}

/** The login name, for `loginctl`. `USER`/`LOGNAME` first; `id -un` when neither is exported. */
export function loginName(input: Pick<PersistenceProbeInput, "ctx" | "exec">): string {
  const named = (input.ctx.env.USER ?? input.ctx.env.LOGNAME ?? "").trim();
  if (named !== "") return named;
  const asked = input.exec.capture("id", ["-un"]);
  return asked.found && asked.code === 0 ? asked.stdout.trim() : "";
}

/**
 * Read the facts. Read-only in the same structural sense as `doctor`: every call is a `capture` of a
 * query (`is-enabled`, `is-active`, `show-user`, `launchctl print`) or a file `exists`/`ownerUid`.
 */
export function probePersistence(input: PersistenceProbeInput): PersistenceFacts {
  const platform = platformOf(input.host.platform);
  const base = {
    platform,
    tier: input.tier,
    installKind: input.installKind ?? "unknown",
    instance: input.ctx.instance,
    muxName: input.mux.name,
    muxReachable: input.mux.reachable,
  } as const;
  if (platform === "linux" && input.tier === "systemd") {
    const unit = unitName(input.ctx.instance);
    const enabled = input.exec.capture("systemctl", ["--user", "is-enabled", unit]);
    const active = input.exec.capture("systemctl", ["--user", "is-active", unit]);
    // `show` is what names the LOADED unit: a same-named file in this user's own unit directory is
    // not evidence when systemd loaded another fragment, or one whose ExecStart points at a different
    // install or instance. All three properties are reads.
    const show = input.exec.capture("systemctl", [
      "--user",
      "show",
      unit,
      "--property=LoadState,FragmentPath,UnitFileState,ExecStart",
    ]);
    const loaded = linuxIdentity(input, { found: show.found, code: show.code, stdout: show.stdout });
    // The caller resolves the name once (it may need `id -un`); an empty one asks again here so a
    // probe used on its own still reports the truth rather than skipping linger.
    const user = input.user.trim() === "" ? loginName(input) : input.user.trim();
    const linger =
      user === ""
        ? null
        : (() => {
            const asked = input.exec.capture("loginctl", ["show-user", user, "--property=Linger"]);
            if (!asked.found || asked.code !== 0) return null;
            const word = /^Linger=(.+)$/m.exec(asked.stdout)?.[1]?.trim().toLowerCase();
            return word === "yes" || word === "true" ? true : word === "no" || word === "false" ? false : null;
          })();
    return {
      ...base,
      serviceFile: ownership(input.files, unitFilePath(input.ctx.home, input.ctx.instance), input.uid()),
      identity: loaded.identity,
      durability: loaded.durability,
      serviceEnabled: enabled.found ? triState(enabled.stdout, ENABLED_TRUE, ENABLED_FALSE) : null,
      serviceActive: active.found ? triState(active.stdout, ACTIVE_TRUE, ACTIVE_FALSE) : null,
      linger,
      launchdDomain: null,
    };
  }
  if (platform === "darwin" && input.tier === "launchd") {
    const label = agentLabel(input.ctx.instance);
    const uid = input.uid();
    const jobs: LaunchdJob[] = [];
    for (const candidate of ["gui", "user"] as const) {
      const asked = input.exec.capture("launchctl", ["print", `${candidate}/${uid}/${label}`]);
      if (!asked.found || asked.code !== 0 || asked.stdout.trim() === "") continue;
      const job = parseLaunchdJob(candidate, asked.stdout);
      if (job !== null) jobs.push(job);
    }
    // A stopped job in the GUI domain and a running one in the user domain is one job in two
    // places; the runner is the fact that matters, not whichever domain was asked first.
    const job = jobs.find((candidate) => candidate.running) ?? jobs[0] ?? null;
    const file = agentFilePath(input.ctx.home, input.ctx.instance);
    if (job === null) {
      return {
        ...base,
        serviceFile: ownership(input.files, file, uid),
        identity: "unknown",
        durability: "unknown",
        serviceEnabled: false,
        serviceActive: false,
        linger: null,
        launchdDomain: null,
      };
    }
    const loaded = launchdFacts(input, job, uid);
    return {
      ...base,
      serviceFile: ownership(input.files, file, uid),
      identity: loaded.identity,
      durability: loaded.durability,
      serviceEnabled: loaded.serviceEnabled,
      serviceActive: loaded.serviceActive,
      linger: null,
      launchdDomain: job.domain,
    };
  }
  // Windows keeps Task Scheduler exactly as it was, and every other platform has no verified
  // supervision scheme here. Neither is probed: there is nothing this module could honestly assert.
  return {
    ...base,
    serviceFile: "absent",
    identity: "unknown",
    durability: "unknown",
    serviceEnabled: null,
    serviceActive: null,
    linger: null,
    launchdDomain: null,
  };
}

/**
 * The judgement: facts in, one report out. No I/O, so the whole matrix — unknown, unsupervised,
 * login-bound, mux-down and fully ready — is exercised by tests without a service manager.
 */
export function judgePersistence(facts: PersistenceFacts): PersistenceReport {
  const reasons: PersistenceReason[] = [];
  const push = (reason: PersistenceReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  let ready = false;
  let guarantee: PersistenceGuarantee = "unknown";
  let loginRequirement: PersistenceReport["loginRequirement"] = "unknown";

  if (facts.platform === "win32") {
    guarantee = "unsupported";
    push("windows-unchanged");
  } else if (facts.platform !== "linux" && facts.platform !== "darwin") {
    guarantee = "unsupported";
    push("unsupported-platform");
  } else if (facts.tier === "unsupervised") {
    guarantee = "unsupervised";
    push("unsupervised");
  } else if (facts.platform === "linux") {
    if (facts.tier !== "systemd") {
      guarantee = "unsupervised";
      push("no-systemd");
    } else {
      loginRequirement = facts.linger === true ? "none" : facts.linger === false ? "after-login" : "unknown";
      guarantee = facts.linger === true ? "unattended" : "after-login";
      if (facts.serviceFile === "absent") push("service-file-missing");
      else if (facts.serviceFile === "foreign") push("service-file-foreign");
      else if (facts.serviceFile === "unknown") push("service-file-unreadable");
      if (facts.identity === "other") push("service-identity-other");
      else if (facts.identity === "unknown") push("service-identity-unknown");
      if (facts.durability === "runtime-only") push("service-runtime-only");
      else if (facts.durability === "transient") push("service-not-durable");
      else if (facts.durability === "unknown") push("unreadable");
      if (facts.serviceEnabled === null) push("unreadable");
      else if (!facts.serviceEnabled) push("service-disabled");
      if (facts.serviceActive === null) push("unreadable");
      else if (!facts.serviceActive) push("service-inactive");
      if (facts.linger === null) push("linger-unknown");
      else if (!facts.linger) push("linger-disabled");
      ready =
        facts.serviceFile === "owned" &&
        facts.identity === "current" &&
        facts.durability === "persistent" &&
        facts.serviceEnabled === true &&
        facts.serviceActive === true &&
        facts.linger === true;
    }
  } else {
    // macOS: launchd, login-scoped. A job loaded in either the GUI or the user domain is supervised;
    // the GUI domain is the ordinary after-login case. An externally managed job of the same label is
    // recognised by its loaded state, never replaced because its plist is not ours.
    loginRequirement = "after-login";
    guarantee = "after-login";
    if (facts.serviceFile === "absent") push("service-file-missing");
    else if (facts.serviceFile === "foreign") push("service-file-foreign");
    else if (facts.serviceFile === "unknown") push("service-file-unreadable");
    if (facts.launchdDomain === null) {
      push("launchd-not-loaded");
    } else {
      if (facts.serviceEnabled !== true) push("launchd-not-loaded");
      else if (facts.serviceActive !== true) push("launchd-not-running");
      if (facts.serviceEnabled === false) push("service-disabled-override");
      if (facts.identity === "other") push("service-identity-other");
      else if (facts.identity === "unknown") push("service-identity-unknown");
      if (facts.durability === "transient") push("service-not-durable");
      else if (facts.durability === "unknown") push("unreadable");
    }
    ready =
      facts.serviceFile === "owned" &&
      facts.launchdDomain !== null &&
      facts.serviceEnabled === true &&
      facts.serviceActive === true &&
      facts.identity === "current" &&
      facts.durability === "persistent";
  }

  if (ready || guarantee === "unattended" || guarantee === "after-login") {
    if (facts.muxReachable === false) {
      push("mux-unreachable");
      ready = false;
    } else if (facts.muxReachable === null) {
      push("mux-unknown");
      ready = false;
    }
  }

  if (ready) push("ready");
  return {
    ready,
    guarantee,
    platform: facts.platform,
    supervisionTier: facts.tier,
    installKind: facts.installKind,
    instance: facts.instance,
    identity: facts.identity,
    durability: facts.durability,
    serviceEnabled: facts.serviceEnabled,
    serviceActive: facts.serviceActive,
    loginRequirement,
    linger: facts.linger,
    launchdDomain: facts.launchdDomain,
    muxName: facts.muxName,
    muxReachable: facts.muxReachable,
    reasons,
    detail: persistenceDetail({ ...facts, ready, guarantee, loginRequirement, reasons }),
  };
}

/** One line an operator can read without decoding reason codes. */
function persistenceDetail(input: PersistenceFacts & Pick<PersistenceReport, "ready" | "guarantee" | "loginRequirement" | "reasons">): string {
  const mux = `${input.muxName} ${input.muxReachable === true ? "answers" : input.muxReachable === false ? "is not answering" : "was not asked"}`;
  if (input.guarantee === "unsupported") {
    return input.platform === "win32"
      ? "persistent verification is not supported on Windows; Task Scheduler keeps its existing behaviour"
      : `persistent verification is not supported on ${input.platform}`;
  }
  if (input.guarantee === "unsupervised") {
    return `no verified supervisor is running this bridge (${input.reasons.join(", ")}); ${mux}`;
  }
  if (input.platform === "linux") {
    const service = `systemd user service ${input.serviceEnabled === true ? "enabled" : input.serviceEnabled === false ? "not enabled" : "unreadable"}, ${input.serviceActive === true ? "active" : input.serviceActive === false ? "not active" : "activity unreadable"}`;
    const identity =
      input.identity === "current"
        ? "runs this install and instance"
        : input.identity === "other"
          ? "runs another install or instance"
          : "ownership unverified";
    const durability =
      input.durability === "persistent"
        ? "persistent"
        : input.durability === "runtime-only"
          ? "enabled for this boot only"
          : input.durability === "transient"
            ? "not persistent"
            : "durability unreadable";
    const linger = input.linger === true ? "linger on" : input.linger === false ? "linger off" : "linger unreadable";
    return `${service}, ${identity}, ${durability}, ${linger}; ${mux}${input.ready ? " — survives logout and reboot (machine booted, disk unlocked, network up, Herdr running)" : ""}`;
  }
  const domain = input.launchdDomain === null ? "not loaded" : `loaded in ${input.launchdDomain}/${input.serviceActive === true ? "running" : "not running"}`;
  const identity =
    input.identity === "current"
      ? "this install and instance"
      : input.identity === "other"
        ? "another install or instance"
        : "ownership unverified";
  const durability =
    input.durability === "persistent"
      ? "RunAtLoad + KeepAlive"
      : input.durability === "transient"
        ? "one-shot or disabled"
        : "durability unreadable";
  return `launchd job ${domain} (${identity}, ${durability}); ${mux}${input.ready ? " — starts and restarts the bridge while this user is logged in; not before login" : ""}`;
}

/** The command that starts this Collie where it actually lives. */
function startCommand(report: Pick<PersistenceReport, "installKind" | "instance">): string {
  if (report.installKind === "detached-checkout") return herdrActionCommand("start", report.instance);
  return report.instance === null ? "collie start" : `COLLIE_INSTANCE=${report.instance} collie start`;
}

/** The command that restarts this Collie where it actually lives. */
function restartCommand(report: Pick<PersistenceReport, "installKind" | "instance">): string {
  if (report.installKind === "detached-checkout") return herdrActionCommand("restart", report.instance);
  return report.instance === null ? "collie restart" : `COLLIE_INSTANCE=${report.instance} collie restart`;
}

/** The read-only inspection a service of unverified ownership deserves. */
function inspectCommand(report: Pick<PersistenceReport, "platform" | "instance" | "launchdDomain">): string {
  if (report.platform === "darwin") {
    const label = agentLabel(report.instance);
    if (report.launchdDomain !== null) return `launchctl print ${report.launchdDomain}/$(id -u)/${label}`;
    // Neither domain answered, so which one holds the job is unknown. Ask both, and change neither.
    return `launchctl print gui/$(id -u)/${label}; launchctl print user/$(id -u)/${label}`;
  }
  // `show` names the LOADED unit, including a FragmentPath outside this user's own unit directory —
  // `cat` would only reprint the file we already have.
  return `systemctl --user show ${unitName(report.instance)} --property=LoadState,FragmentPath,UnitFileState,ExecStart`;
}

/** The one thing to try next, in the order that resolves the most blocking reason first. */
export function persistenceRemedy(report: PersistenceReport): string {
  const has = (reason: PersistenceReason): boolean => report.reasons.includes(reason);
  if (has("windows-unchanged")) return "Windows keeps Task Scheduler; run `collie doctor` there instead of `--persistent`";
  if (has("unsupported-platform")) return "run `collie doctor` on the target; this platform has no verified persistent scheme";
  if (has("service-identity-other"))
    return `the loaded service runs a different Collie install or instance; inspect it read-only with \`${inspectCommand(report)}\` and do not replace it`;
  if (has("service-identity-unknown"))
    return `the loaded service could not be matched to this install; inspect it read-only with \`${inspectCommand(report)}\` and do not replace it`;
  if (has("service-file-foreign")) return "the service file belongs to another user; check the service user instead of replacing it";
  if (has("service-file-unreadable")) return "check the ownership of the service file with `ls -l` there";
  if (has("unsupervised") || has("no-systemd") || has("service-file-missing") || has("service-disabled") || has("service-runtime-only") || has("service-not-durable") || has("service-disabled-override") || has("launchd-not-loaded"))
    return `run \`${startCommand(report)}\` on that machine to install or repair its supervisor`;
  if (has("service-inactive") || has("launchd-not-running")) return `run \`${restartCommand(report)}\` on that machine`;
  if (has("unreadable")) return `\`${inspectCommand(report)}\` on that machine to read the service state`;
  if (has("linger-disabled")) return "`loginctl enable-linger $USER` once on that machine (may need policy approval)";
  if (has("linger-unknown")) return "`loginctl show-user $USER --property=Linger` on that machine";
  if (has("mux-unreachable")) return `start the configured ${report.muxName} multiplexer; Collie keeps running without it`;
  if (has("mux-unknown")) return "ask again once the bridge answers: `collie status --json` there";
  return "run the check again on the target machine";
}

/**
 * The findings `doctor --only persistence` prints: one overall verdict, then the three layers an
 * operator has to tell apart (supervision, login, mux). Every one carries the same `data`.
 */
export function persistenceFindings(report: PersistenceReport): Finding[] {
  const data = persistenceJson(report);
  const overall: Finding = report.ready
    ? { ...ok("persistence", report.detail), data }
    : { ...bad("persistence", report.detail, persistenceRemedy(report)), data };
  return [overall, ...layerFindings(report, data)];
}

function layerFindings(report: PersistenceReport, data: JsonObject): Finding[] {
  const has = (reason: PersistenceReason): boolean => report.reasons.includes(reason);
  const unsupported = report.guarantee === "unsupported";
  const service =
    unsupported || report.guarantee === "unsupervised"
      ? skipped("persistence-service", "no verified service manager on this platform", "run `collie doctor` on the target")
      : report.platform === "linux"
        ? has("service-identity-other") || has("service-identity-unknown") || has("service-runtime-only") || has("service-not-durable") || has("service-disabled") || has("service-inactive") || has("service-file-missing") || has("service-file-foreign")
          ? bad(
              "persistence-service",
              `user service ${report.serviceEnabled === true ? "enabled" : "not enabled"}, ${report.serviceActive === true ? "active" : "not active"}, ${report.identity === "current" ? "runs this install" : report.identity === "other" ? "runs another install" : "ownership unverified"}, ${report.durability === "persistent" ? "persistent" : report.durability === "runtime-only" ? "enabled for this boot only" : report.durability === "transient" ? "not persistent" : "durability unreadable"}`,
              persistenceRemedy(report),
            )
          : has("unreadable") || has("service-file-unreadable")
            ? skipped("persistence-service", "the service state could not be read", `\`${inspectCommand(report)}\` on that machine`)
            : ok("persistence-service", "user service enabled, active, persistent and running this install")
        : report.launchdDomain === null || report.serviceActive !== true
          ? bad("persistence-service", `launchd job ${report.launchdDomain === null ? "not loaded" : "not running"}`, persistenceRemedy(report))
          : has("service-identity-other") || has("service-identity-unknown") || has("service-not-durable") || has("service-disabled-override") || has("service-file-missing") || has("service-file-foreign")
            ? bad(
                "persistence-service",
                `launchd job loaded in ${report.launchdDomain}, ${report.identity === "current" ? "runs this install" : report.identity === "other" ? "runs another install" : "ownership unverified"}, ${report.durability === "persistent" ? "RunAtLoad + KeepAlive" : report.durability === "transient" ? "one-shot or disabled" : "durability unreadable"}`,
                persistenceRemedy(report),
              )
            : has("unreadable")
              ? skipped("persistence-service", "the job definition could not be read", `\`${inspectCommand(report)}\` on that machine`)
              : ok("persistence-service", `launchd job loaded in ${report.launchdDomain}, running this install with RunAtLoad + KeepAlive`);

  const login =
    unsupported || report.guarantee === "unsupervised"
      ? skipped("persistence-login", "no login requirement is verified here", "run `collie doctor` on the target")
      : report.platform === "linux"
        ? report.linger === true
          ? ok("persistence-login", "linger is on — the user service survives the last logout")
          : report.linger === false
            ? bad("persistence-login", "linger is off — the service stops with the last login session", persistenceRemedy(report))
            : skipped("persistence-login", "linger could not be read", persistenceRemedy(report))
        : ok("persistence-login", "after-login guarantee: launchd starts the job when the user logs in");

  const mux =
    report.muxReachable === true
      ? ok("persistence-mux", `${report.muxName} answered`)
      : report.muxReachable === false
        ? bad("persistence-mux", `${report.muxName} is not answering; the bridge can still be online`, persistenceRemedy(report))
        : skipped("persistence-mux", `${report.muxName} was not asked`, persistenceRemedy(report));

  return [
    { ...service, data },
    { ...login, data },
    { ...mux, data },
  ];
}

/** The report as JSON, without the readonly interface's index-signature friction. */
export function persistenceJson(report: PersistenceReport): JsonObject {
  return {
    ready: report.ready,
    guarantee: report.guarantee,
    platform: report.platform,
    supervisionTier: report.supervisionTier,
    installKind: report.installKind,
    instance: report.instance,
    identity: report.identity,
    durability: report.durability,
    serviceEnabled: report.serviceEnabled,
    serviceActive: report.serviceActive,
    loginRequirement: report.loginRequirement,
    linger: report.linger,
    launchdDomain: report.launchdDomain,
    muxName: report.muxName,
    muxReachable: report.muxReachable,
    reasons: [...report.reasons],
    detail: report.detail,
  };
}

/**
 * A bridge's own `/api/snapshot` reduced to "does the configured mux answer".
 *
 * `connected` with no `muxFault` is the only positive answer. A `muxFault`, or a `disconnected`
 * bridge, is a real negative. A refused or silent read is unknown: the bridge not answering is not
 * evidence about the multiplexer behind it.
 */
export function muxReachabilityFromSnapshot(
  read: { readonly kind: "body"; readonly text: string } | { readonly kind: "refused"; readonly status: number } | { readonly kind: "silent" },
): boolean | null {
  if (read.kind !== "body") return null;
  const doc = asJsonObject(parseJson(read.text));
  if (doc === undefined) return null;
  if (doc.muxFault !== undefined && doc.muxFault !== null) return false;
  const bridge = asJsonString(doc.bridge);
  if (bridge === "connected") return true;
  if (bridge === "disconnected") return false;
  return null;
}

const GUARANTEES = ["unattended", "after-login", "unsupervised", "unsupported", "unknown"] as const;
const PLATFORMS = ["linux", "darwin", "win32", "other"] as const;
const TIERS = ["systemd", "launchd", "taskscheduler", "unsupervised"] as const;
const LOGIN_REQUIREMENTS = ["none", "after-login", "unknown"] as const;
const INSTALL_KINDS = ["linked-clone", "detached-checkout", "binary", "packaged", "unknown"] as const;
const IDENTITIES = ["current", "other", "unknown"] as const;
const DURABILITIES = ["persistent", "runtime-only", "transient", "unknown"] as const;
const REASONS = [
  "ready",
  "unsupported-platform",
  "windows-unchanged",
  "no-systemd",
  "service-file-missing",
  "service-file-foreign",
  "service-file-unreadable",
  "service-identity-other",
  "service-identity-unknown",
  "service-runtime-only",
  "service-not-durable",
  "service-disabled-override",
  "service-disabled",
  "service-inactive",
  "linger-disabled",
  "linger-unknown",
  "launchd-not-loaded",
  "launchd-not-running",
  "unsupervised",
  "mux-unreachable",
  "mux-unknown",
  "unreadable",
] as const satisfies readonly PersistenceReason[];

function asEnum<T extends string>(values: readonly T[], value: JsonValue | undefined): T | undefined {
  const text = asJsonString(value);
  return values.find((candidate) => candidate === text);
}

function asGuarantee(value: JsonValue | undefined): PersistenceGuarantee | undefined {
  return asEnum(GUARANTEES, value);
}

function asPlatform(value: JsonValue | undefined): PersistenceFacts["platform"] | undefined {
  return asEnum(PLATFORMS, value);
}

function asTier(value: JsonValue | undefined): Tier | undefined {
  return asEnum(TIERS, value);
}

function asLoginRequirement(value: JsonValue | undefined): PersistenceReport["loginRequirement"] | undefined {
  return asEnum(LOGIN_REQUIREMENTS, value);
}

/** A required tri-state boolean: `true`, `false` or `null`, never absent and never a string. */
function asNullableBoolean(value: JsonValue | undefined): boolean | null | undefined {
  if (value === null) return null;
  return asJsonBoolean(value);
}

/** A required nullable string: the string, or `null`, never absent. */
function asNullableString(value: JsonValue | undefined): string | null | undefined {
  if (value === null) return null;
  return asJsonString(value);
}

function asReasons(value: JsonValue | undefined): PersistenceReason[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons: PersistenceReason[] = [];
  for (const item of value) {
    const reason = asEnum(REASONS, item);
    // An unknown code means this build cannot read that report's shape. Dropping it would turn a
    // future "not ready" into a false success, so the whole row is refused.
    if (reason === undefined) return undefined;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** Does a parsed report contradict itself? Any contradiction is unverified, never ready. */
function consistent(report: PersistenceReport): boolean {
  const has = (reason: PersistenceReason): boolean => report.reasons.includes(reason);
  if (report.ready) {
    if (report.reasons.length !== 1 || !has("ready")) return false;
    if (report.identity !== "current" || report.durability !== "persistent") return false;
    if (report.serviceEnabled !== true || report.serviceActive !== true) return false;
    if (report.muxReachable !== true) return false;
    if (report.platform === "linux") {
      if (report.guarantee !== "unattended") return false;
      if (report.supervisionTier !== "systemd") return false;
      if (report.linger !== true || report.loginRequirement !== "none") return false;
    } else if (report.platform === "darwin") {
      if (report.guarantee !== "after-login") return false;
      if (report.supervisionTier !== "launchd") return false;
      if (report.launchdDomain === null || report.loginRequirement !== "after-login") return false;
    } else {
      return false;
    }
  } else if (has("ready")) {
    return false;
  }
  if (has("windows-unchanged") && report.platform !== "win32") return false;
  if (has("unsupported-platform") && report.platform !== "other") return false;
  if (has("no-systemd") && (report.platform !== "linux" || report.supervisionTier === "systemd")) return false;
  if ((has("launchd-not-loaded") || has("launchd-not-running")) && report.platform !== "darwin") return false;
  if (report.guarantee === "unattended" && report.platform !== "linux") return false;
  if (report.guarantee === "after-login" && report.platform !== "linux" && report.platform !== "darwin") return false;
  return true;
}

/**
 * The report inside `doctor --only persistence --json`'s output, or null when the far side printed
 * something this build cannot read (an older member, a broken run, no binary).
 *
 * A null is NOT a failure of the member's service: it is "unverified", and the caller says exactly
 * that rather than turning a mixed-version fleet into a false negative.
 */
export function parsePersistenceReport(stdout: string): PersistenceReport | null {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  const parsed = parseJson(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed)) return null;
  const row = parsed
    .map(asJsonObject)
    .find((candidate) => candidate !== undefined && asJsonString(candidate.check) === "persistence");
  if (row === undefined) return null;
  const data = asJsonObject(row.data);
  if (data === undefined) return null;
  const ready = asJsonBoolean(data.ready);
  const guarantee = asGuarantee(data.guarantee);
  const platform = asPlatform(data.platform);
  const supervisionTier = asTier(data.supervisionTier);
  const installKind = asEnum(INSTALL_KINDS, data.installKind);
  const instance = asNullableString(data.instance);
  const identity = asEnum(IDENTITIES, data.identity);
  const durability = asEnum(DURABILITIES, data.durability);
  const serviceEnabled = asNullableBoolean(data.serviceEnabled);
  const serviceActive = asNullableBoolean(data.serviceActive);
  const loginRequirement = asLoginRequirement(data.loginRequirement);
  const linger = asNullableBoolean(data.linger);
  const domainValue = asNullableString(data.launchdDomain);
  const muxName = asJsonString(data.muxName);
  const muxReachable = asNullableBoolean(data.muxReachable);
  const reasons = asReasons(data.reasons);
  const detail = asJsonString(data.detail);
  if (
    ready === undefined ||
    guarantee === undefined ||
    platform === undefined ||
    supervisionTier === undefined ||
    installKind === undefined ||
    instance === undefined ||
    identity === undefined ||
    durability === undefined ||
    serviceEnabled === undefined ||
    serviceActive === undefined ||
    loginRequirement === undefined ||
    linger === undefined ||
    domainValue === undefined ||
    muxName === undefined ||
    muxReachable === undefined ||
    reasons === undefined ||
    detail === undefined
  ) {
    return null;
  }
  if (domainValue !== null && domainValue !== "gui" && domainValue !== "user") return null;
  const report: PersistenceReport = {
    ready,
    guarantee,
    platform,
    supervisionTier,
    installKind,
    instance,
    identity,
    durability,
    serviceEnabled,
    serviceActive,
    loginRequirement,
    linger,
    launchdDomain: domainValue,
    muxName,
    muxReachable,
    reasons,
    detail,
  };
  return consistent(report) ? report : null;
}
