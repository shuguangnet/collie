import { describe, expect, test } from "bun:test";
import { MachineProfilesStore, type MachineProfileInput } from "./machine-profiles.ts";
import { serveMachineProfilesRoute } from "./machine-profiles-http.ts";
import type { MachineRouteCaller } from "./server.ts";
import type { AuditEntry } from "./audit.ts";

const INPUT: MachineProfileInput = { name: "Work", sshHost: "work", port: 8787, mux: "herdr", leadAddress: "", peerAddress: "", remotePath: "", instance: "" };
function harness(seed: string | null = null) {
  let text = seed; const gates: string[] = []; const audit: AuditEntry[] = [];
  const store = new MachineProfilesStore({ read: async () => text, write: async (v) => { text = v; } });
  const caller: MachineRouteCaller = { gate: (level) => { gates.push(level); return null; }, device: () => "phone", audit: (entry) => { audit.push(entry); } };
  const request = (method: string, body?: string) => new Request("http://127.0.0.1/api/machine-profiles", { method, body });
  const send = (method: string, body?: string, enabled = true) => serveMachineProfilesRoute(request(method, body), "/api/machine-profiles", caller, store, enabled);
  return { store, caller, request, send, gates, audit, text: () => text };
}
describe("machine profile HTTP surface", () => {
  test("GET is paired read; writes need the write gate; no files on GET", async () => {
    const h = harness(); const res = (await h.send("GET"))!;
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ version: 1, profiles: [], muxes: expect.arrayContaining(["herdr"]) }); expect(h.text()).toBeNull();
    const saved = (await h.send("POST", JSON.stringify(INPUT)))!;
    expect(saved.status).toBe(201);
    const id = (await h.store.read()).profiles[0]!.id;
    expect((await h.send("DELETE", JSON.stringify({ id })))!.status).toBe(200);
    expect(h.gates).toEqual(["read", "write", "write"]);
    expect(h.audit.map((e) => e.action)).toEqual(["machine-profile.save", "machine-profile.remove"]);
    expect(h.audit.every((e) => e.device === "phone")).toBe(true);
  });
  for (const method of ["GET", "POST", "DELETE"]) {
    test(`denied ${method} has no side effects or metadata`, async () => {
      const h = harness();
      const res = await serveMachineProfilesRoute(h.request(method, method === "GET" ? undefined : JSON.stringify(INPUT)), "/api/machine-profiles", { ...h.caller, gate: () => new Response("denied", { status: 403 }) }, h.store, true);
      expect(res!.status).toBe(403); expect(h.text()).toBeNull(); expect(h.audit).toHaveLength(0);
    });
    test(`peer refuses ${method}`, async () => { const h = harness(); expect((await h.send(method, undefined, false))!.status).toBe(404); });
  }
  test("malformed JSON, unknown credentials and oversized streamed bodies are refused", async () => {
    const h = harness();
    for (const body of ["broken", JSON.stringify({ ...INPUT, password: "never persist" })]) expect((await h.send("POST", body))!.status).toBe(400);
    expect((await h.send("POST", "x".repeat(5000)))!.status).toBe(413);
    const req = new Request("http://127.0.0.1/api/machine-profiles", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(4097))); c.close(); } }) });
    expect((await serveMachineProfilesRoute(req, "/api/machine-profiles", h.caller, h.store, true))!.status).toBe(413);
    expect(h.text()).toBeNull();
  });
  test("duplicate profile is 409; damaged storage is 503 for both reads and writes", async () => {
    const h = harness(); await h.send("POST", JSON.stringify(INPUT));
    expect((await h.send("POST", JSON.stringify(INPUT)))!.status).toBe(409);
    const broken = harness("broken");
    for (const method of ["GET", "POST", "DELETE"]) expect((await broken.send(method, method === "GET" ? undefined : JSON.stringify(INPUT)))!.status).toBe(method === "DELETE" ? 400 : 503);
    expect(broken.text()).toBe("broken");
  });
  test("wrong route returns null and unsupported method is 405", async () => {
    const h = harness(); expect(await serveMachineProfilesRoute(h.request("GET"), "/other", h.caller, h.store, true)).toBeNull();
    expect((await h.send("PUT"))!.status).toBe(405);
  });
});
