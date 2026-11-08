import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import { readOwnerFile, writeOwnerFileAtomic } from "./owner-file.ts";
import { buildMuxRegistry, DEFAULT_MUX, muxNames } from "./mux/registry.ts";

// Saved connection PARAMETERS, never membership or credentials. Crew remains the only authority
// for pinned identities and runtime reconnect. Saving here performs no outbound request (ADR 0134).
export const MACHINE_PROFILES_FILENAME = "machine-profiles.json";
export const MACHINE_PROFILES_MAX = 64;
export const MACHINE_PROFILES_MAX_BYTES = 512 * 1024;
export const MACHINE_PROFILE_BODY_MAX = 4096;
export const PROFILE_ID = /^[a-f0-9]{24}$/;

export interface MachineProfileInput {
  name: string;
  sshHost: string;
  port: number;
  mux: string;
  leadAddress: string;
  peerAddress: string;
  remotePath: string;
  instance: string;
}
export interface MachineProfile extends MachineProfileInput {
  id: string;
  createdAt: number;
}
export interface MachineProfilesDocument {
  version: 1;
  profiles: MachineProfile[];
}
export interface MachineProfilesIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
export class MachineProfilesError extends Error {}

const INPUT_KEYS = new Set(["name", "sshHost", "port", "mux", "leadAddress", "peerAddress", "remotePath", "instance"]);
export const MACHINE_PROFILE_MUXES = [...new Set([DEFAULT_MUX, ...muxNames(buildMuxRegistry())])];
const MUXES = new Set(MACHINE_PROFILE_MUXES);
const clean = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);
const record = (v: JsonValue | undefined): JsonObject | null =>
  v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : null;

/** Only conservative OpenSSH destinations: alias, host, user@host, bracketed IPv6. No options. */
export function safeProfileSshHost(s: string): boolean {
  return s.length <= 255 && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$/.test(s);
}
function safePeer(s: string): boolean {
  return s === "" || (s.length <= 255 && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$/.test(s));
}
function safeLead(s: string): boolean {
  if (s === "") return true;
  if (s.length > 512 || !clean(s) || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname !== "" && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

/** Strict whitelist: even a password-shaped extra field is refused rather than silently stored. */
export function parseMachineProfileInput(raw: JsonValue | undefined): MachineProfileInput | null {
  const o = record(raw);
  if (!o || Object.keys(o).some((k) => !INPUT_KEYS.has(k))) return null;
  if (typeof o.name !== "string" || !clean(o.name) || o.name.trim() === "" || o.name.length > 48) return null;
  if (typeof o.sshHost !== "string" || !safeProfileSshHost(o.sshHost)) return null;
  if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return null;
  if (typeof o.mux !== "string" || !MUXES.has(o.mux)) return null;
  if (typeof o.leadAddress !== "string" || !safeLead(o.leadAddress)) return null;
  if (typeof o.peerAddress !== "string" || !safePeer(o.peerAddress)) return null;
  if (typeof o.remotePath !== "string" || o.remotePath.length > 1024 || !clean(o.remotePath)) return null;
  if (typeof o.instance !== "string" || (o.instance !== "" && !/^[a-z0-9-]{1,16}$/.test(o.instance))) return null;
  return {
    name: o.name.trim(), sshHost: o.sshHost, port: o.port,
    mux: o.mux,
    leadAddress: o.leadAddress, peerAddress: o.peerAddress, remotePath: o.remotePath, instance: o.instance,
  };
}
export function parseMachineProfiles(text: string | null): MachineProfilesDocument {
  if (text === null) return { version: 1, profiles: [] };
  let v: JsonValue;
  try {
    // SAFETY: JSON.parse returns JSON; the exact document and every input are validated below.
    v = JSON.parse(text) as JsonValue;
  } catch { throw new MachineProfilesError("machine profiles are not valid JSON"); }
  const o = record(v);
  if (!o || o.version !== 1 || !Array.isArray(o.profiles) || o.profiles.length > MACHINE_PROFILES_MAX ||
      Object.keys(o).some((k) => k !== "version" && k !== "profiles")) throw new MachineProfilesError("machine profiles schema is unavailable");
  const profiles: MachineProfile[] = [];
  for (const raw of o.profiles) {
    const row = record(raw);
    if (!row || typeof row.id !== "string" || !PROFILE_ID.test(row.id) ||
        typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
        Object.keys(row).some((k) => !INPUT_KEYS.has(k) && k !== "id" && k !== "createdAt")) {
      throw new MachineProfilesError("machine profile is invalid");
    }
    const { id, createdAt, ...input } = row;
    const parsed = parseMachineProfileInput(input);
    if (!parsed || profiles.some((p) => p.id === id || p.name === parsed.name)) throw new MachineProfilesError("machine profile is invalid or duplicated");
    profiles.push({ ...parsed, id, createdAt });
  }
  return { version: 1, profiles };
}
export function fileMachineProfilesIo(stateDir: string): MachineProfilesIo {
  const path = join(stateDir, MACHINE_PROFILES_FILENAME);
  const error = (message: string, options?: { cause?: unknown }) => new MachineProfilesError(message, options);
  return {
    read: () => readOwnerFile(path, MACHINE_PROFILES_FILENAME, MACHINE_PROFILES_MAX_BYTES, error),
    write: (text) => writeOwnerFileAtomic(path, MACHINE_PROFILES_FILENAME, text, error),
  };
}

/** Re-read on each call: the bridge and CLI see the same state, never a browser's local cache. */
export class MachineProfilesStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly io: MachineProfilesIo, private readonly now = Date.now, private readonly id = () => randomBytes(12).toString("hex")) {}
  async read(): Promise<MachineProfilesDocument> { return parseMachineProfiles(await this.io.read()); }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => undefined); return next;
  }
  save(input: MachineProfileInput): Promise<MachineProfilesDocument> {
    return this.serialize(async () => {
      const doc = await this.read();
      if (doc.profiles.some((p) => p.name === input.name)) throw new MachineProfilesError("duplicate");
      if (doc.profiles.length >= MACHINE_PROFILES_MAX) throw new MachineProfilesError("limit");
      const id = this.id();
      if (!PROFILE_ID.test(id) || doc.profiles.some((p) => p.id === id)) throw new MachineProfilesError("profile id collision");
      const next: MachineProfilesDocument = { version: 1, profiles: [...doc.profiles, { ...input, id, createdAt: this.now() }] };
      await this.io.write(JSON.stringify(next)); return next;
    });
  }
  remove(id: string): Promise<MachineProfilesDocument> {
    return this.serialize(async () => {
      const doc = await this.read();
      if (!doc.profiles.some((p) => p.id === id)) throw new MachineProfilesError("not-found");
      const next: MachineProfilesDocument = { version: 1, profiles: doc.profiles.filter((p) => p.id !== id) };
      await this.io.write(JSON.stringify(next)); return next;
    });
  }
}
/** Parameters go to the existing parser as argv, never to a shell. All checks and prompts survive. */
export function machineProfileArgs(p: MachineProfile): string[] {
  const args = [p.sshHost, `--label=${p.name}`, `--port=${p.port}`, `--mux=${p.mux}`, "--persistent"];
  for (const [flag, value] of [["address", p.leadAddress], ["peer-address", p.peerAddress], ["path", p.remotePath], ["instance", p.instance]]) {
    if (value) args.push(`--${flag}=${value}`);
  }
  return args;
}
