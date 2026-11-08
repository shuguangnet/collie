import { describe, expect, test, vi } from "vitest";
import { createOpenBoot, takeOpenGuide, type OpenBootDeps } from "./open-boot";

function deps(held: string | null = null) {
  let token = held;
  return {
    ready: vi.fn(async () => {}), token: () => token,
    probe: vi.fn<OpenBootDeps["probe"]>(async () => "valid"),
    wipe: vi.fn(async () => { token = null; }),
    exchange: vi.fn(async () => "issued-token"),
    save: vi.fn((value: string) => { token = value; }), accepted: vi.fn(),
  };
}

describe("one-time local boot", () => {
  test("erases a fragment without adding history", () => {
    const replaceState = vi.fn();
    const guide = "a".repeat(43);
    expect(takeOpenGuide({ hash: `#collie-open=${guide}`, pathname: "/collie/", search: "", hostname: "127.0.0.1", protocol: "http:" }, { replaceState, state: null })).toBe(guide);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/collie/");
  });
  test("rejects remote or malformed fragments, still erasing them", () => {
    for (const [hostname, guide] of [["other.example", "a".repeat(43)], ["127.0.0.1", "short"]]) {
      const replaceState = vi.fn();
      expect(takeOpenGuide({ hash: `#collie-open=${guide}`, pathname: "/", search: "", hostname, protocol: "http:" }, { replaceState, state: null })).toBeNull();
      expect(replaceState).toHaveBeenCalled();
    }
  });
  test("history failure cannot leave a guide visible while exchanging it", () => {
    expect(takeOpenGuide({ hash: `#collie-open=${"a".repeat(43)}`, pathname: "/", search: "", hostname: "127.0.0.1", protocol: "http:" }, { replaceState: () => { throw Error(); }, state: null })).toBeNull();
  });
  test("concurrent startup calls exchange once and persist the issued token", async () => {
    const d = deps(); const boot = createOpenBoot("guide", d);
    await Promise.all([boot.settle(), boot.settle()]);
    expect(d.exchange).toHaveBeenCalledExactlyOnceWith("guide");
    expect(d.token()).toBe("issued-token");
    expect(boot.failed()).toBe(false);
  });
  test("existing accepted tokens avoid another device registration", async () => {
    const d = deps("held"); await createOpenBoot("guide", d).settle();
    expect(d.exchange).not.toHaveBeenCalled(); expect(d.token()).toBe("held");
  });
  test("503 or network uncertainty keeps the token and does not exchange", async () => {
    const d = deps("held"); d.probe.mockResolvedValue("unknown");
    const boot = createOpenBoot("guide", d); await boot.settle();
    expect(d.wipe).not.toHaveBeenCalled(); expect(d.exchange).not.toHaveBeenCalled();
    expect(d.token()).toBe("held"); expect(boot.failed()).toBe(true);
  });
  test("a single refusal followed by recovery never wipes", async () => {
    const d = deps("held"); d.probe.mockResolvedValueOnce("revoked").mockResolvedValueOnce("valid");
    await createOpenBoot("guide", d).settle();
    expect(d.wipe).not.toHaveBeenCalled(); expect(d.exchange).not.toHaveBeenCalled();
  });
  test("two confirmed refusals clear old private data before saving a new token", async () => {
    const d = deps("held"); d.probe.mockResolvedValue("expired");
    await createOpenBoot("guide", d).settle();
    expect(d.wipe).toHaveBeenCalledExactlyOnceWith("expired");
    expect(d.wipe.mock.invocationCallOrder[0]).toBeLessThan(d.save.mock.invocationCallOrder[0]);
    expect(d.token()).toBe("issued-token");
  });
  test("no guide performs no requests; failed exchanges are never silently retried", async () => {
    const d = deps(); await createOpenBoot(null, d).settle(); expect(d.exchange).not.toHaveBeenCalled();
    d.exchange.mockRejectedValue(Error()); const boot = createOpenBoot("guide", d);
    await boot.settle(); await boot.settle();
    expect(d.exchange).toHaveBeenCalledTimes(1); expect(boot.failed()).toBe(true);
  });
});
