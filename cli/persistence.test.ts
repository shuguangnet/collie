import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import type { JsonValue } from "../bridge/json.ts";
import { agentFilePath, agentLabel, unitFilePath } from "./unit.ts";
import {
  judgePersistence,
  loginName,
  muxReachabilityFromSnapshot,
  parsePersistenceReport,
  persistenceFindings,
  persistenceJson,
  persistenceRemedy,
  probePersistence,
  type PersistenceFacts,
} from "./persistence.ts";
import { context, fakeExec, fakeFiles, HOME } from "./fakes.ts";

// The persistent-runtime judgement, with no service manager anywhere. `judgePersistence` is pure, so
// the whole matrix — ready, login-bound, unsupervised, unsupported, mux-down, unreadable — is stated
// as facts. `probePersistence` is exercised against the shared fakes for the two platforms whose
// queries this build actually runs, and for the two it deliberately does not.

const facts = (over: Partial<PersistenceFacts> = {}): PersistenceFacts => ({
  platform: "linux",
  tier: "systemd",
  installKind: "binary",
  instance: null,
  serviceFile: "owned",
  identity: "current",
  durability: "persistent",
  serviceEnabled: true,
  serviceActive: true,
  linger: true,
  launchdDomain: null,
  muxName: "herdr",
  muxReachable: true,
  ...over,
});

const linuxReady = () => facts();

/** `systemctl --user show`'s four properties, as systemd prints them. */
const linuxShow = (
  over: { fragment?: string; enabled?: string; exec?: string; loadState?: string } = {},
): string =>
  [
    `LoadState=${over.loadState ?? "loaded"}`,
    `FragmentPath=${over.fragment ?? unitFilePath(HOME)}`,
    `UnitFileState=${over.enabled ?? "enabled"}`,
    `ExecStart=${over.exec ?? "{ path=/opt/collie/bin/collie ; argv[]=/opt/collie/bin/collie _exec-bridge ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }"}`,
  ].join("\n");

/** A generated plist, with only the keys this module reads varied. */
const macPlist = (
  over: {
    label?: string;
    program?: string;
    argv?: string[];
    runAtLoad?: boolean;
    keepAlive?: boolean;
    disabled?: boolean;
  } = {},
): string => {
  const label = over.label ?? agentLabel(null);
  const argv = over.argv ?? [over.program ?? "/opt/collie/bin/collie", "_exec-bridge"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${a}</string>`).join("")}</array>
  ${over.runAtLoad === false ? "" : "<key>RunAtLoad</key><true/>"}
  ${over.keepAlive === false ? "" : "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"}
  ${over.disabled === true ? "<key>Disabled</key><true/>" : ""}
</dict></plist>`;
};

/** `launchctl print`'s answer, reduced to the fields {@link probePersistence} reads. */
const launchdPrint = (
  over: { path: string; program?: string; argv?: string[]; pid?: number | null; state?: string } = { path: "" },
): string =>
  [
    `path = ${over.path}`,
    `program = ${over.program ?? "/opt/collie/bin/collie"}`,
    "arguments = {",
    ...(over.argv ?? ["/opt/collie/bin/collie", "_exec-bridge"]).map((a) => `\t${a}`),
    "}",
    ...(over.state === undefined ? [] : [`state = ${over.state}`]),
    ...(over.pid === null ? [] : [`pid = ${over.pid ?? 4242}`]),
  ].join("\n");

describe("the persistence judgement", () => {
  test("a supervised Linux service with linger is ready for an unattended restart", () => {
    const report = judgePersistence(linuxReady());
    expect(report.ready).toBe(true);
    expect(report.guarantee).toBe("unattended");
    expect(report.loginRequirement).toBe("none");
    expect(report.reasons).toEqual(["ready"]);
    expect(report.detail).toContain("survives logout and reboot");
  });

  test("without linger the service is only as durable as the login session", () => {
    const report = judgePersistence(facts({ linger: false }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("after-login");
    expect(report.loginRequirement).toBe("after-login");
    expect(report.reasons).toContain("linger-disabled");
    expect(report.detail).toContain("linger off");
  });

  test("an unreadable linger answer is unknown, never treated as off or on", () => {
    const report = judgePersistence(facts({ linger: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("after-login");
    expect(report.loginRequirement).toBe("unknown");
    expect(report.reasons).toContain("linger-unknown");
  });

  test("a service whose enable or active state cannot be read is not ready", () => {
    const report = judgePersistence(facts({ serviceEnabled: null, serviceActive: null }));
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("unreadable");
    expect(report.detail).toContain("unreadable");
  });

  test("a disabled, inactive, missing or foreign unit is not ready", () => {
    for (const over of [
      { serviceEnabled: false },
      { serviceActive: false },
      { serviceFile: "absent" as const },
      { serviceFile: "foreign" as const },
      { serviceFile: "unknown" as const },
    ]) {
      const report = judgePersistence(facts(over));
      expect(report.ready).toBe(false);
    }
    expect(judgePersistence(facts({ serviceEnabled: false })).reasons).toContain("service-disabled");
    expect(judgePersistence(facts({ serviceActive: false })).reasons).toContain("service-inactive");
    expect(judgePersistence(facts({ serviceFile: "absent" })).reasons).toContain("service-file-missing");
    expect(judgePersistence(facts({ serviceFile: "foreign" })).reasons).toContain("service-file-foreign");
    expect(judgePersistence(facts({ serviceFile: "unknown" })).reasons).toContain("service-file-unreadable");
  });

  test("a machine with no systemd is unsupervised rather than falsely ready", () => {
    const report = judgePersistence(facts({ tier: "unsupervised", serviceFile: "absent", serviceEnabled: null, serviceActive: null, linger: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupervised");
    expect(report.reasons).toContain("unsupervised");
  });

  test("a Linux host whose resolved tier is not systemd says no-systemd, never ready", () => {
    const report = judgePersistence(facts({ platform: "linux", tier: "launchd", serviceFile: "absent", serviceEnabled: null, serviceActive: null, linger: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupervised");
    expect(report.reasons).toContain("no-systemd");
  });

  test("the tier being unsupervised short-circuits even when other facts look ready", () => {
    const report = judgePersistence(facts({ tier: "unsupervised" }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupervised");
    expect(report.reasons).toEqual(["unsupervised"]);
  });

  test("a stopped multiplexer makes an otherwise supervised bridge not ready, without losing the guarantee", () => {
    const report = judgePersistence(facts({ muxReachable: false }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unattended");
    expect(report.reasons).toContain("mux-unreachable");
    expect(report.detail).toContain("is not answering");
  });

  test("an unasked multiplexer is unknown, and never a guessed ready", () => {
    const report = judgePersistence(facts({ muxReachable: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unattended");
    expect(report.reasons).toContain("mux-unknown");
    expect(report.detail).toContain("was not asked");
  });

  test("an unsupported platform is unsupported, not ready and not a failure of the bridge", () => {
    const report = judgePersistence(facts({ platform: "other", tier: "unsupervised" }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupported");
    expect(report.reasons).toContain("unsupported-platform");
  });

  test("Windows keeps Task Scheduler and is explicitly not verified", () => {
    const report = judgePersistence(facts({ platform: "win32", tier: "taskscheduler", serviceFile: "absent", serviceEnabled: null, serviceActive: null, linger: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupported");
    expect(report.reasons).toContain("windows-unchanged");
    expect(report.detail).toContain("Task Scheduler");
  });

  test("a launchd job that is loaded and running is an after-login guarantee", () => {
    const report = judgePersistence(facts({ platform: "darwin", tier: "launchd", launchdDomain: "gui", linger: null }));
    expect(report.ready).toBe(true);
    expect(report.guarantee).toBe("after-login");
    expect(report.loginRequirement).toBe("after-login");
    expect(report.reasons).toEqual(["ready"]);
    expect(report.detail).toContain("starts and restarts");
    expect(report.detail).toContain("not before login");
    expect(report.detail).not.toContain("survives logout");
  });

  test("a runtime-only enable or an unverified identity is never ready, even when enabled and active", () => {
    const runtimeOnly = judgePersistence(facts({ durability: "runtime-only" }));
    expect(runtimeOnly.ready).toBe(false);
    expect(runtimeOnly.reasons).toContain("service-runtime-only");

    const otherInstall = judgePersistence(facts({ identity: "other" }));
    expect(otherInstall.ready).toBe(false);
    expect(otherInstall.reasons).toContain("service-identity-other");

    const unknownIdentity = judgePersistence(facts({ identity: "unknown" }));
    expect(unknownIdentity.ready).toBe(false);
    expect(unknownIdentity.reasons).toContain("service-identity-unknown");

    const transient = judgePersistence(facts({ durability: "transient" }));
    expect(transient.ready).toBe(false);
    expect(transient.reasons).toContain("service-not-durable");
  });

  test("a one-shot or disabled launchd job is not ready even when it is loaded and running", () => {
    const oneShot = judgePersistence(
      facts({ platform: "darwin", tier: "launchd", launchdDomain: "gui", durability: "transient", linger: null }),
    );
    expect(oneShot.ready).toBe(false);
    expect(oneShot.reasons).toContain("service-not-durable");

    const disabled = judgePersistence(
      facts({ platform: "darwin", tier: "launchd", launchdDomain: "gui", durability: "transient", serviceEnabled: false, linger: null }),
    );
    expect(disabled.ready).toBe(false);
    expect(disabled.reasons).toContain("service-disabled-override");
  });

  test("a launchd plist owned by another account is not ready even when the job is loaded", () => {
    const report = judgePersistence(
      facts({ platform: "darwin", tier: "launchd", launchdDomain: "gui", serviceFile: "foreign", linger: null }),
    );
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("service-file-foreign");
  });

  test("a launchd job that is not loaded, or loaded but not running, is not ready", () => {
    const notLoaded = judgePersistence(facts({ platform: "darwin", tier: "launchd", launchdDomain: null, serviceEnabled: false, serviceActive: false, linger: null }));
    expect(notLoaded.ready).toBe(false);
    expect(notLoaded.reasons).toContain("launchd-not-loaded");

    const stopped = judgePersistence(facts({ platform: "darwin", tier: "launchd", launchdDomain: "user", serviceActive: false, linger: null }));
    expect(stopped.ready).toBe(false);
    expect(stopped.reasons).toContain("launchd-not-running");
  });

  test("macOS without launchd is unsupervised", () => {
    const report = judgePersistence(facts({ platform: "darwin", tier: "unsupervised", launchdDomain: null, linger: null }));
    expect(report.ready).toBe(false);
    expect(report.guarantee).toBe("unsupervised");
  });

  test("every remedy names a next action for the reason that blocks the check", () => {
    const cases: [Partial<PersistenceFacts>, string][] = [
      [{ platform: "win32", tier: "taskscheduler" }, "Task Scheduler"],
      [{ platform: "other" }, "no verified persistent scheme"],
      [{ tier: "unsupervised" }, "collie start"],
      [{ serviceFile: "absent" }, "collie start"],
      [{ serviceFile: "foreign" }, "another user"],
      [{ serviceEnabled: null, serviceActive: null, linger: true }, "systemctl --user show collie"],
      [{ serviceEnabled: false }, "collie start"],
      [{ serviceActive: false }, "collie restart"],
      [{ durability: "runtime-only" }, "collie start"],
      [{ identity: "other" }, "do not replace it"],
      [{ identity: "unknown" }, "do not replace it"],
      [{ linger: false }, "loginctl enable-linger"],
      [{ linger: null }, "loginctl show-user"],
      [{ platform: "darwin", tier: "launchd", launchdDomain: null }, "collie start"],
      [{ platform: "darwin", tier: "launchd", launchdDomain: "gui", serviceActive: false }, "collie restart"],
      [{ platform: "darwin", tier: "launchd", launchdDomain: "gui", durability: "transient" }, "collie start"],
      [{ muxReachable: false }, "multiplexer"],
      [{ muxReachable: null }, "status --json"],
    ];
    for (const [over, expected] of cases) {
      expect(persistenceRemedy(judgePersistence(facts(over)))).toContain(expected);
    }
  });

  test("a Herdr-managed install is told to use the plugin action, for the right instance", () => {
    const remedy = persistenceRemedy(
      judgePersistence(facts({ installKind: "detached-checkout", instance: "next", serviceActive: false })),
    );
    expect(remedy).toContain("herdr plugin action invoke restart --plugin herdr.collie-next");
    expect(remedy).not.toContain("collie restart");
    expect(remedy).not.toContain("herdr.collie ");
  });

  test("a named instance of any other install is named in the command", () => {
    const remedy = persistenceRemedy(
      judgePersistence(facts({ installKind: "binary", instance: "next", serviceActive: false })),
    );
    expect(remedy).toContain("COLLIE_INSTANCE=next collie restart");
    expect(remedy).not.toContain("systemctl --user start");
  });
});

describe("the persistence findings", () => {
  test("a ready machine carries one verdict and three agreeing layers", () => {
    const report = judgePersistence(linuxReady());
    const findings = persistenceFindings(report);
    expect(findings.map((f) => f.check)).toEqual([
      "persistence",
      "persistence-service",
      "persistence-login",
      "persistence-mux",
    ]);
    for (const finding of findings) {
      expect(finding.status).toBe("ok");
      expect(finding.remedy).toBeNull();
      expect(finding.data).toEqual(persistenceJson(report));
    }
  });

  test("a blocked machine's overall verdict is an error with the one next step", () => {
    const report = judgePersistence(facts({ linger: false }));
    const [overall, service, login, mux] = persistenceFindings(report);
    expect(overall!.status).toBe("error");
    expect(overall!.remedy).toContain("loginctl enable-linger");
    expect(service!.status).toBe("ok");
    expect(login!.status).toBe("error");
    expect(mux!.status).toBe("ok");
  });

  test("an unreadable layer is skipped, with a remedy, never a failure", () => {
    const report = judgePersistence(facts({ serviceEnabled: null, serviceActive: null, linger: null }));
    const [, service, login] = persistenceFindings(report);
    expect(service!.status).toBe("skipped");
    expect(service!.remedy).not.toBeNull();
    expect(login!.status).toBe("skipped");
    expect(login!.remedy).not.toBeNull();

    // A unit file that exists but cannot be stat'd is also unreadable, not a green service row.
    const unknownOwner = persistenceFindings(judgePersistence(facts({ serviceFile: "unknown" })));
    expect(unknownOwner[1]!.status).toBe("skipped");
    expect(unknownOwner[1]!.detail).toContain("could not be read");
  });

  test("an unsupported platform skips service and login, and still answers the mux", () => {
    const report = judgePersistence(facts({ platform: "win32", tier: "taskscheduler" }));
    const [, service, login, mux] = persistenceFindings(report);
    expect(service!.status).toBe("skipped");
    expect(login!.status).toBe("skipped");
    expect(mux!.status).toBe("ok");
  });

  test("an unsupervised machine skips service and login, and never claims an after-login guarantee", () => {
    for (const over of [
      { platform: "darwin" as const, tier: "unsupervised" as const, launchdDomain: null, linger: null },
      { platform: "linux" as const, tier: "unsupervised" as const, linger: null },
    ]) {
      const report = judgePersistence(facts(over));
      expect(report.guarantee).toBe("unsupervised");
      const [, service, login] = persistenceFindings(report);
      expect(service!.status).toBe("skipped");
      expect(login!.status).toBe("skipped");
      expect(login!.detail).not.toContain("after-login guarantee");
    }
  });
});

describe("the persistence report as JSON", () => {
  test("the probe output round-trips through the remote parser", () => {
    const report = judgePersistence(facts({ muxReachable: false }));
    const stdout = JSON.stringify([{ check: "something-else", status: "ok", detail: "x", remedy: null }, ...persistenceFindings(report)]);
    expect(parsePersistenceReport(stdout)).toEqual(report);
  });

  test("an older member's unrelated output, a broken run or no output is unverified, not a failure", () => {
    expect(parsePersistenceReport("")).toBeNull();
    expect(parsePersistenceReport("collie: command not found")).toBeNull();
    expect(parsePersistenceReport("[]")).toBeNull();
    expect(parsePersistenceReport(JSON.stringify([{ check: "persistence", status: "ok", detail: "x", remedy: null }]))).toBeNull();
    expect(parsePersistenceReport(JSON.stringify([{ check: "persistence", data: { ready: true } }]))).toBeNull();
  });

  test("a partial row that only has ready/guarantee/reasons is refused, not read as success", () => {
    const stdout = JSON.stringify([
      { check: "persistence", data: { ready: true, guarantee: "unattended", reasons: [] } },
    ]);
    expect(parsePersistenceReport(stdout)).toBeNull();
  });

  test("an unknown reason or enum value is refused rather than dropped", () => {
    const report = judgePersistence(linuxReady());
    const data = { ...persistenceJson(report), reasons: ["ready", "future-reason"] };
    expect(parsePersistenceReport(JSON.stringify([{ check: "persistence", data }]))).toBeNull();

    const badIdentity = { ...persistenceJson(report), identity: "somebody-elses" };
    expect(parsePersistenceReport(JSON.stringify([{ check: "persistence", data: badIdentity }]))).toBeNull();

    const badInstall = { ...persistenceJson(report), installKind: "tarball" };
    expect(parsePersistenceReport(JSON.stringify([{ check: "persistence", data: badInstall }]))).toBeNull();
  });

  test("a report that contradicts itself is unverified, never ready", () => {
    const report = judgePersistence(linuxReady());
    const data = persistenceJson(report);
    const rows = (over: Record<string, JsonValue>): string =>
      JSON.stringify([{ check: "persistence", data: { ...data, ...over } }]);

    // ready true with the mux known to be down.
    expect(parsePersistenceReport(rows({ muxReachable: false }))).toBeNull();
    // ready true while the service is not running.
    expect(parsePersistenceReport(rows({ serviceActive: false }))).toBeNull();
    // ready true while the loaded unit runs another install.
    expect(parsePersistenceReport(rows({ identity: "other" }))).toBeNull();
    // ready true while the enable only lasts this boot.
    expect(parsePersistenceReport(rows({ durability: "runtime-only" }))).toBeNull();
    // ready true with a non-ready reason attached.
    expect(parsePersistenceReport(rows({ reasons: ["ready", "linger-disabled"] }))).toBeNull();
    // ready true while linger is unknown, so unattended cannot be proved.
    expect(parsePersistenceReport(rows({ linger: null }))).toBeNull();
    // not ready while claiming the ready reason.
    expect(parsePersistenceReport(rows({ ready: false }))).toBeNull();
    // A platform-specific reason on the wrong platform.
    expect(parsePersistenceReport(rows({ reasons: ["windows-unchanged"] }))).toBeNull();
  });

  test("a tri-state boolean may be null but may not be missing or a string", () => {
    const report = judgePersistence(facts({ linger: null }));
    const data = persistenceJson(report);
    const rows = (over: Record<string, JsonValue>): string =>
      JSON.stringify([{ check: "persistence", data: { ...data, ...over } }]);
    expect(parsePersistenceReport(rows({ linger: null }))).not.toBeNull();
    expect(parsePersistenceReport(rows({ serviceEnabled: "yes" }))).toBeNull();
    expect(parsePersistenceReport(rows({ muxReachable: 1 }))).toBeNull();
    expect(parsePersistenceReport(rows({ launchdDomain: "system" }))).toBeNull();
  });

  test("the parser reads only the persistence row and tolerates a human banner around it", () => {
    const report = judgePersistence(linuxReady());
    const stdout = `collie doctor\n${JSON.stringify(persistenceFindings(report))}\n`;
    expect(parsePersistenceReport(stdout)?.ready).toBe(true);
  });
});

describe("mux reachability from a snapshot", () => {
  test("a connected bridge with no fault is the only positive answer", () => {
    expect(muxReachabilityFromSnapshot({ kind: "body", text: JSON.stringify({ bridge: "connected" }) })).toBe(true);
  });

  test("a disconnected bridge or a mux fault is a real negative", () => {
    expect(muxReachabilityFromSnapshot({ kind: "body", text: JSON.stringify({ bridge: "disconnected" }) })).toBe(false);
    expect(
      muxReachabilityFromSnapshot({ kind: "body", text: JSON.stringify({ bridge: "connected", muxFault: "unreachable" }) }),
    ).toBe(false);
  });

  test("a refused, silent, unparseable or unknown read is unknown", () => {
    expect(muxReachabilityFromSnapshot({ kind: "refused", status: 502 })).toBeNull();
    expect(muxReachabilityFromSnapshot({ kind: "silent" })).toBeNull();
    expect(muxReachabilityFromSnapshot({ kind: "body", text: "not json" })).toBeNull();
    expect(muxReachabilityFromSnapshot({ kind: "body", text: JSON.stringify({ bridge: "starting" }) })).toBeNull();
  });
});

describe("reading the facts", () => {
  test("Linux asks systemd and loginctl only, and owns the unit file", () => {
    const unit = unitFilePath(HOME);
    const files = fakeFiles({ [unit]: "[Unit]\nDescription=Collie\n" });
    const exec = fakeExec({
      answers: [
        ["systemctl --user is-enabled", { stdout: "enabled\n" }],
        ["systemctl --user is-active", { stdout: "active\n" }],
        ["systemctl --user show", { stdout: `${linuxShow()}\n` }],
        ["loginctl show-user pat", { stdout: "Linger=yes\n" }],
      ],
    });
    const probed = probePersistence({
      ctx: context({ USER: "pat" }),
      exec,
      files,
      host: hostFor("linux"),
      uid: () => 1000,
      user: "pat",
      tier: "systemd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed).toMatchObject({
      platform: "linux",
      serviceFile: "owned",
      identity: "current",
      durability: "persistent",
      serviceEnabled: true,
      serviceActive: true,
      linger: true,
      launchdDomain: null,
    });
    expect(exec.calls).toEqual([
      "systemctl --user is-enabled collie",
      "systemctl --user is-active collie",
      "systemctl --user show collie --property=LoadState,FragmentPath,UnitFileState,ExecStart",
      "loginctl show-user pat --property=Linger",
    ]);
    expect(judgePersistence(probed).ready).toBe(true);
  });

  test("a runtime-only enable is not ready even though the unit answers enabled and active", () => {
    const unit = unitFilePath(HOME);
    const exec = fakeExec({
      answers: [
        ["systemctl --user is-enabled", { stdout: "enabled-runtime\n" }],
        ["systemctl --user is-active", { stdout: "active\n" }],
        ["systemctl --user show", { stdout: `${linuxShow({ enabled: "enabled-runtime" })}\n` }],
        ["loginctl show-user pat", { stdout: "Linger=yes\n" }],
      ],
    });
    const probed = probePersistence({
      ctx: context({ USER: "pat" }),
      exec,
      files: fakeFiles({ [unit]: "[Unit]\n" }),
      host: hostFor("linux"),
      uid: () => 1000,
      user: "pat",
      tier: "systemd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.serviceEnabled).toBe(true);
    expect(probed.durability).toBe("runtime-only");
    const report = judgePersistence(probed);
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("service-runtime-only");
  });

  test("a loaded unit whose FragmentPath or ExecStart is another install is not this one", () => {
    const unit = unitFilePath(HOME);
    const otherFragment = "/home/pat/other/collie.service";
    const otherExec = "{ path=/opt/other/bin/collie ; argv[]=/opt/other/bin/collie _exec-bridge ; ignore_errors=no ; pid=0 ; status=0/0 }";
    for (const show of [
      linuxShow({ fragment: otherFragment }),
      linuxShow({ exec: otherExec }),
      linuxShow({ exec: "{ path=/opt/collie/bin/collie ; argv[]=/opt/collie/bin/collie _exec-bridge --instance next ; pid=0 ; status=0/0 }" }),
    ]) {
      const probed = probePersistence({
        ctx: context({ USER: "pat" }),
        exec: fakeExec({
          answers: [
            ["systemctl --user is-enabled", { stdout: "enabled\n" }],
            ["systemctl --user is-active", { stdout: "active\n" }],
            ["systemctl --user show", { stdout: `${show}\n` }],
            ["loginctl show-user pat", { stdout: "Linger=yes\n" }],
          ],
        }),
        files: fakeFiles({ [unit]: "[Unit]\n" }),
        host: hostFor("linux"),
        uid: () => 1000,
        user: "pat",
        tier: "systemd",
        mux: { name: "herdr", reachable: true },
      });
      expect(probed.identity).toBe("other");
      const report = judgePersistence(probed);
      expect(report.ready).toBe(false);
      expect(report.reasons).toContain("service-identity-other");
    }
  });

  test("a named instance's unit is matched by its own ExecStart, not the default instance", () => {
    const unit = unitFilePath(HOME, "next");
    const probed = probePersistence({
      ctx: context({ USER: "pat" }, { instance: "next" }),
      exec: fakeExec({
        answers: [
          ["systemctl --user is-enabled", { stdout: "enabled\n" }],
          ["systemctl --user is-active", { stdout: "active\n" }],
          [
            "systemctl --user show",
            {
              stdout: `${linuxShow({
                fragment: unitFilePath(HOME, "next"),
                exec: "{ path=/opt/collie/bin/collie ; argv[]=/opt/collie/bin/collie _exec-bridge --instance next ; pid=0 ; status=0/0 }",
              })}\n`,
            },
          ],
          ["loginctl show-user pat", { stdout: "Linger=yes\n" }],
        ],
      }),
      files: fakeFiles({ [unit]: "[Unit]\n" }),
      host: hostFor("linux"),
      uid: () => 1000,
      user: "pat",
      tier: "systemd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.identity).toBe("current");
    expect(judgePersistence(probed).ready).toBe(true);
  });

  test("Linux with no systemd bus records unknowns instead of inventing an absence", () => {
    const exec = fakeExec({ absent: ["systemctl", "loginctl"] });
    const probed = probePersistence({
      ctx: context({ USER: "pat" }),
      exec,
      files: fakeFiles(),
      host: hostFor("linux"),
      uid: () => 1000,
      user: "pat",
      tier: "systemd",
      mux: { name: "herdr", reachable: null },
    });
    expect(probed.serviceEnabled).toBeNull();
    expect(probed.serviceActive).toBeNull();
    expect(probed.linger).toBeNull();
    const report = judgePersistence(probed);
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("unreadable");
    expect(report.reasons).toContain("linger-unknown");
  });

  test("a unit owned by another account is foreign, not ours", () => {
    const unit = unitFilePath(HOME);
    const files = fakeFiles({ [unit]: "[Unit]\n" });
    files.rootOwned.add(unit);
    const probed = probePersistence({
      ctx: context({ USER: "pat" }),
      exec: fakeExec({
        answers: [
          ["systemctl --user is-enabled", { stdout: "enabled\n" }],
          ["systemctl --user is-active", { stdout: "active\n" }],
          ["loginctl show-user pat", { stdout: "Linger=yes\n" }],
        ],
      }),
      files,
      host: hostFor("linux"),
      uid: () => 1000,
      user: "pat",
      tier: "systemd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.serviceFile).toBe("foreign");
    expect(judgePersistence(probed).reasons).toContain("service-file-foreign");
  });

  test("macOS reads the loaded job and its plist, and recognises a persistent one", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const exec = fakeExec({
      answers: [
        [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist }) }],
        ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
      ],
    });
    const probed = probePersistence({
      ctx: context({}),
      exec,
      files: fakeFiles({ [plist]: macPlist() }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed).toMatchObject({
      platform: "darwin",
      serviceFile: "owned",
      identity: "current",
      durability: "persistent",
      serviceEnabled: true,
      serviceActive: true,
      launchdDomain: "gui",
      linger: null,
    });
    expect(judgePersistence(probed).ready).toBe(true);
  });

  test("a one-shot plist, or a disabled override, is recognised but not ready", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    for (const [text, reason] of [
      [macPlist({ keepAlive: false }), "service-not-durable"],
      [macPlist({ runAtLoad: false }), "service-not-durable"],
      [macPlist({ disabled: true }), "service-disabled-override"],
    ] as const) {
      const probed = probePersistence({
        ctx: context({}),
        exec: fakeExec({
          answers: [
            [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist }) }],
            ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
          ],
        }),
        files: fakeFiles({ [plist]: text }),
        host: hostFor("darwin"),
        uid: () => 1000,
        user: "",
        tier: "launchd",
        mux: { name: "herdr", reachable: true },
      });
      const report = judgePersistence(probed);
      expect(report.ready).toBe(false);
      expect(report.reasons).toContain(reason);
    }

    const overridden = probePersistence({
      ctx: context({}),
      exec: fakeExec({
        answers: [
          [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist }) }],
          ["launchctl print-disabled gui/1000", { stdout: `"${label}" => true\n` }],
        ],
      }),
      files: fakeFiles({ [plist]: macPlist() }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(overridden.serviceEnabled).toBe(false);
    expect(judgePersistence(overridden).reasons).toContain("service-disabled-override");
  });

  test("an externally managed launchd job of the same label is recognised, not replaced", () => {
    const label = agentLabel(null);
    const foreign = "/Library/LaunchAgents/herdr.collie.plist";
    const exec = fakeExec({
      answers: [
        [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: foreign }) }],
        ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
      ],
    });
    // No plist of ours: launchd already has a job with the same label from another manager.
    const probed = probePersistence({
      ctx: context({}),
      exec,
      files: fakeFiles({ [foreign]: macPlist() }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.serviceFile).toBe("absent");
    expect(probed.identity).toBe("other");
    expect(probed.launchdDomain).toBe("gui");
    const report = judgePersistence(probed);
    expect(report.ready).toBe(false);
    expect(report.reasons).toContain("service-identity-other");
    // The only write-shaped verb in the module is none: the probe asked and stopped.
    expect(exec.calls.every((call) => call.startsWith("launchctl print"))).toBe(true);
  });

  test("a job whose plist points at another program is not this install", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const probed = probePersistence({
      ctx: context({}),
      exec: fakeExec({
        answers: [
          [
            `launchctl print gui/1000/${label}`,
            { stdout: launchdPrint({ path: plist, program: "/opt/other/bin/collie" }) },
          ],
          ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
        ],
      }),
      files: fakeFiles({ [plist]: macPlist({ program: "/opt/other/bin/collie" }) }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.identity).toBe("other");
    expect(judgePersistence(probed).ready).toBe(false);
  });

  test("a running job's instance arguments must match the plist and current install", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const probed = probePersistence({
      ctx: context({}),
      exec: fakeExec({ answers: [
        [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist, argv: ["/opt/collie/bin/collie", "_exec-bridge", "--instance", "other"] }) }],
        ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
      ] }),
      files: fakeFiles({ [plist]: macPlist() }),
      host: hostFor("darwin"), uid: () => 1000, user: "", tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.identity).toBe("other");
    expect(judgePersistence(probed).ready).toBe(false);
  });

  test("an arbitrary conditional KeepAlive dictionary does not prove crash recovery", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const text = macPlist().replace("<key>SuccessfulExit</key><false/>", "<key>NetworkState</key><true/>");
    const probed = probePersistence({
      ctx: context({}),
      exec: fakeExec({ answers: [
        [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist }) }],
        ["launchctl print-disabled gui/1000", { stdout: `"${label}" => false\n` }],
      ] }),
      files: fakeFiles({ [plist]: text }),
      host: hostFor("darwin"), uid: () => 1000, user: "", tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(judgePersistence(probed).ready).toBe(false);
  });

  test("when the GUI job is stopped and the user job is running, the runner is found", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const probed = probePersistence({
      ctx: context({}),
      exec: fakeExec({
        answers: [
          [`launchctl print gui/1000/${label}`, { stdout: launchdPrint({ path: plist, pid: null, state: "not running" }) }],
          [`launchctl print user/1000/${label}`, { stdout: launchdPrint({ path: plist, pid: 99 }) }],
          ["launchctl print-disabled user/1000", { stdout: `"${label}" => false\n` }],
        ],
      }),
      files: fakeFiles({ [plist]: macPlist() }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.launchdDomain).toBe("user");
    expect(probed.serviceActive).toBe(true);
    expect(judgePersistence(probed).ready).toBe(true);
  });

  test("macOS falls back to the user domain, and reports a loaded job with no pid as stopped", () => {
    const label = agentLabel(null);
    const plist = agentFilePath(HOME);
    const exec = fakeExec({
      answers: [
        [`launchctl print user/1000/${label}`, { stdout: launchdPrint({ path: plist, pid: null, state: "running" }) }],
        ["launchctl print-disabled user/1000", { stdout: `"${label}" => false\n` }],
      ],
    });
    const probed = probePersistence({
      ctx: context({}),
      exec,
      files: fakeFiles({ [plist]: macPlist() }),
      host: hostFor("darwin"),
      uid: () => 1000,
      user: "",
      tier: "launchd",
      mux: { name: "herdr", reachable: true },
    });
    expect(probed.launchdDomain).toBe("user");
    expect(probed.serviceActive).toBe(false);
    expect(judgePersistence(probed).reasons).toContain("launchd-not-running");
  });

  test("Windows is not probed at all: Task Scheduler keeps its existing behaviour", () => {
    const exec = fakeExec();
    const probed = probePersistence({
      ctx: context({}),
      exec,
      files: fakeFiles(),
      host: hostFor("win32"),
      uid: () => 1000,
      user: "",
      tier: "taskscheduler",
      mux: { name: "herdr", reachable: true },
    });
    expect(exec.calls).toEqual([]);
    expect(probed).toMatchObject({ platform: "win32", serviceFile: "absent", serviceEnabled: null });
    expect(judgePersistence(probed).guarantee).toBe("unsupported");
  });

  test("the login name comes from USER, then LOGNAME, then id -un", () => {
    expect(loginName({ ctx: context({ USER: "pat", LOGNAME: "other" }), exec: fakeExec() })).toBe("pat");
    expect(loginName({ ctx: context({ LOGNAME: "other" }), exec: fakeExec() })).toBe("other");
    const exec = fakeExec({ answers: [["id -un", { stdout: "from-id\n" }]] });
    expect(loginName({ ctx: context({}), exec })).toBe("from-id");
  });
});
