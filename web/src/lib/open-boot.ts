import { exchangeAccess } from "./access-login";
import { mounted } from "./base-path";
import { clearNotPaired, getDeviceToken, setDeviceToken } from "./pairing";
import { resumePendingWipe, wipeDevice } from "./wipe";

/** Capture and erase the one-time fragment before importing the router or running any loader. */
export function takeOpenGuide(location: Pick<Location, "hash" | "pathname" | "search" | "hostname" | "protocol">, history: Pick<History, "replaceState" | "state">): string | null {
  if (!location.hash.startsWith("#collie-open=")) return null;
  const match = /^#collie-open=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  // A failed history operation must not proceed with a secret still visible in the URL.
  try { history.replaceState(history.state, "", location.pathname + location.search); }
  catch { return null; }
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1") return null;
  return match?.[1] ?? null;
}

type Probe = "valid" | "revoked" | "expired" | "unknown";
async function probeToken(token: string): Promise<Probe> {
  try {
    const res = await fetch(mounted("/api/devices"), {
      headers: { authorization: `Bearer ${token}`, "x-requested-with": "XMLHttpRequest" },
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) return "valid";
    if (res.status !== 403) return "unknown";
    const body = await res.text();
    return body === "device not paired" ? "revoked" : body === "device expired" ? "expired" : "unknown";
  } catch { return "unknown"; }
}

export interface OpenBootDeps {
  ready(): Promise<void>;
  token(): string | null;
  probe(token: string): Promise<Probe>;
  wipe(reason: "revoked" | "expired"): Promise<void>;
  exchange(guide: string): Promise<string>;
  save(token: string): void;
  accepted(): void;
}

/** One promise across StrictMode calls. Only two confirmed credential refusals can end a pairing. */
export function createOpenBoot(guide: string | null, deps: OpenBootDeps) {
  let started: Promise<void> | undefined;
  let failed = false;
  return {
    failed: () => failed,
    settle(): Promise<void> {
      started ??= (async () => {
        if (guide === null) return;
        await deps.ready();
        const held = deps.token();
        if (held !== null) {
          const first = await deps.probe(held);
          if (first === "valid") { deps.accepted(); return; }
          if (first === "unknown") { failed = true; return; }
          const second = await deps.probe(held);
          if (second === "valid") { deps.accepted(); return; }
          if (second === "unknown") { failed = true; return; }
          await deps.wipe(second);
        }
        const issued = await deps.exchange(guide);
        deps.save(issued);
        if (deps.token() !== issued) { failed = true; return; }
        deps.accepted();
      })().catch(() => { failed = true; });
      return started;
    },
  };
}

const boot = createOpenBoot(takeOpenGuide(window.location, window.history), {
  ready: async () => { await resumePendingWipe(); },
  token: getDeviceToken,
  probe: probeToken,
  wipe: async (reason) => { await wipeDevice(reason); },
  exchange: (guide) => exchangeAccess("/api/auth/open", { guide }),
  save: setDeviceToken,
  accepted: clearNotPaired,
});
export const settleOpenBoot = () => boot.settle();
export const openBootFailed = () => boot.failed();
