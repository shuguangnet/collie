import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MachineProfilesStore, fileMachineProfilesIo, parseMachineProfileInput, parseMachineProfiles,
  machineProfileArgs, type MachineProfileInput, MACHINE_PROFILES_FILENAME,
} from "./machine-profiles.ts";

export const PROFILE: MachineProfileInput = { name: "Work server", sshHost: "pat@work", port: 8787, mux: "herdr", leadAddress: "", peerAddress: "", remotePath: "", instance: "" };
function memory(text: string | null = null) {
  let value = text; let writes = 0;
  return { io: { read: async () => value, write: async (next: string) => { value = next; writes++; } }, value: () => value, writes: () => writes };
}
describe("machine profile boundary", () => {
  test("normalizes labels and keeps optional fields explicit", () => {
    expect(parseMachineProfileInput({ ...PROFILE, name: " Work " })).toEqual({ ...PROFILE, name: "Work" });
  });
  for (const sshHost of ["-oProxyCommand=evil", "user@host;id", "host\nnext", "ssh://user:password@host", "host:22", "a b", "$(id)", "user@-host", "host/route"]) {
    test(`refuses unsafe SSH destination ${JSON.stringify(sshHost)}`, () => { expect(parseMachineProfileInput({ ...PROFILE, sshHost })).toBeNull(); });
  }
  for (const sshHost of ["work", "user@work.example", "user@[fd7a::1]", "100.64.0.3"]) {
    test(`accepts ${sshHost}`, () => { expect(parseMachineProfileInput({ ...PROFILE, sshHost })).not.toBeNull(); });
  }
  for (const extra of [{ password: "secret" }, { token: "secret" }, { privateKey: "secret" }, { unknown: true }]) {
    test(`refuses unknown fields ${Object.keys(extra)}`, () => { expect(parseMachineProfileInput({ ...PROFILE, ...extra })).toBeNull(); });
  }
  for (const input of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "8787" }, { name: "\u202efake" }, { name: " " }, { mux: "unknown" }, { instance: "../escape" }, { peerAddress: "host:8787" }, { leadAddress: "http://host" }, { leadAddress: "https://user:password@host" }, { leadAddress: "https://host/?token=secret" }, { remotePath: "path\ncommand" }]) {
    test(`refuses malformed fields ${JSON.stringify(input)}`, () => { expect(parseMachineProfileInput({ ...PROFILE, ...input })).toBeNull(); });
  }
  test("disk corruption and duplicate ids fail closed", () => {
    for (const text of ["", "broken", "{}", '{"version":2,"profiles":[]}', '{"version":1,"profiles":[{}]}']) expect(() => parseMachineProfiles(text)).toThrow();
    const p = { ...PROFILE, id: "a".repeat(24), createdAt: 1 };
    expect(() => parseMachineProfiles(JSON.stringify({ version: 1, profiles: [p, { ...p, name: "Other" }] }))).toThrow();
  });
  test("argv contains no shell and inline flags cannot turn a value into another flag", () => {
    const args = machineProfileArgs({ ...PROFILE, name: "--force", remotePath: "--force", id: "a".repeat(24), createdAt: 1 });
    expect(args).toEqual(["pat@work", "--label=--force", "--port=8787", "--mux=herdr", "--persistent", "--path=--force"]);
  });
});
describe("service-owned machine profile store", () => {
  test("a read never creates files; a second store sees writes and removals", async () => {
    const m = memory(); const first = new MachineProfilesStore(m.io); const second = new MachineProfilesStore(m.io);
    expect(await first.read()).toEqual({ version: 1, profiles: [] }); expect(m.writes()).toBe(0);
    const saved = await first.save(PROFILE); expect(saved.profiles).toHaveLength(1);
    expect(await second.read()).toEqual(saved);
    await second.remove(saved.profiles[0]!.id); expect((await first.read()).profiles).toEqual([]);
  });
  test("concurrent saves serialize without lost updates, duplicate names do not overwrite", async () => {
    const m = memory(); const s = new MachineProfilesStore(m.io);
    await Promise.all([s.save(PROFILE), s.save({ ...PROFILE, name: "Second" })]);
    expect((await s.read()).profiles).toHaveLength(2);
    await expect(s.save(PROFILE)).rejects.toThrow("duplicate"); expect((await s.read()).profiles).toHaveLength(2);
    await expect(s.remove("f".repeat(24))).rejects.toThrow("not-found");
  });
  test("damaged and unreadable files are never reset by writes", async () => {
    const m = memory("broken"); const s = new MachineProfilesStore(m.io);
    await expect(s.read()).rejects.toThrow(); await expect(s.save(PROFILE)).rejects.toThrow();
    await expect(s.remove("f".repeat(24))).rejects.toThrow(); expect(m.value()).toBe("broken"); expect(m.writes()).toBe(0);
    const unavailable = new MachineProfilesStore({ read: async () => { throw Error("unavailable"); }, write: m.io.write });
    await expect(unavailable.save(PROFILE)).rejects.toThrow("unavailable"); expect(m.writes()).toBe(0);
  });
  test("failed save is not reported as saved; limits and id collision do not write", async () => {
    const broken = new MachineProfilesStore({ read: async () => null, write: async () => { throw Error("disk full"); } });
    await expect(broken.save(PROFILE)).rejects.toThrow("disk full");
    const m = memory(); const s = new MachineProfilesStore(m.io, () => 1, () => "a".repeat(24));
    await s.save(PROFILE); await expect(s.save({ ...PROFILE, name: "Other" })).rejects.toThrow("collision");
    const profiles = Array.from({ length: 64 }, (_, i) => ({ ...PROFILE, name: `p${i}`, id: i.toString(16).padStart(24, "0"), createdAt: 1 }));
    const capped = memory(JSON.stringify({ version: 1, profiles }));
    await expect(new MachineProfilesStore(capped.io).save(PROFILE)).rejects.toThrow("limit"); expect(capped.writes()).toBe(0);
  });
  test("real files survive store restart and stay owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "profiles-"));
    try {
      const s = new MachineProfilesStore(fileMachineProfilesIo(dir)); await s.read();
      await expect(readFile(join(dir, MACHINE_PROFILES_FILENAME))).rejects.toThrow();
      const saved = await s.save(PROFILE);
      expect(await new MachineProfilesStore(fileMachineProfilesIo(dir)).read()).toEqual(saved);
      expect((await stat(join(dir, MACHINE_PROFILES_FILENAME))).mode & 0o777).toBe(0o600);
      await writeFile(join(dir, MACHINE_PROFILES_FILENAME), "broken");
      await expect(s.save(PROFILE)).rejects.toThrow();
      await chmod(join(dir, MACHINE_PROFILES_FILENAME), 0o644); await expect(s.read()).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
