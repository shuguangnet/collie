import { MachineProfilesError, MACHINE_PROFILE_BODY_MAX, MACHINE_PROFILE_MUXES, PROFILE_ID, parseMachineProfileInput, type MachineProfilesStore } from "./machine-profiles.ts";
import type { JsonValue } from "./json.ts";
import { apiError, type ErrorCode } from "./error-codes.ts";
import type { MachineRouteCaller } from "./server.ts";

const answer = <T>(value: T, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const refusal = (code: ErrorCode, status: number) => answer(apiError(code), status);

/** Bootstrap parameters only. No outbound network or CLI invocation exists on this HTTP surface. */
export async function serveMachineProfilesRoute(
  req: Request,
  pathname: string,
  caller: MachineRouteCaller,
  store: MachineProfilesStore,
  enabled: boolean,
): Promise<Response | null> {
  if (pathname !== "/api/machine-profiles") return null;
  if (!["GET", "POST", "DELETE"].includes(req.method)) return new Response("method not allowed", { status: 405 });
  const denied = caller.gate(req.method === "GET" ? "read" : "write");
  if (denied) return denied;
  if (!enabled) return refusal("crew.not_lead", 404);
  try {
    if (req.method === "GET") return answer({ ...await store.read(), muxes: MACHINE_PROFILE_MUXES });
    // Count actual streamed bytes, not merely Content-Length supplied by the client.
    const reader = req.body?.getReader();
    if (!reader) return refusal("profiles.invalid", 400);
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MACHINE_PROFILE_BODY_MAX) { await reader.cancel(); return refusal("profiles.invalid", 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let raw: JsonValue;
    try {
      // SAFETY: JSON is untrusted; the POST parser and DELETE shape check below validate every field.
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
    } catch { return refusal("profiles.invalid", 400); }
    if (req.method === "POST") {
      const input = parseMachineProfileInput(raw);
      if (!input) return refusal("profiles.invalid", 400);
      const doc = await store.save(input);
      caller.audit({ action: "machine-profile.save", device: caller.device(), detail: { id: doc.profiles.at(-1)!.id } });
      return answer({ ...doc, muxes: MACHINE_PROFILE_MUXES }, 201);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 ||
        typeof raw.id !== "string" || !PROFILE_ID.test(raw.id)) return refusal("profiles.invalid", 400);
    const doc = await store.remove(raw.id);
    caller.audit({ action: "machine-profile.remove", device: caller.device(), detail: { id: raw.id } });
    return answer({ ...doc, muxes: MACHINE_PROFILE_MUXES });
  } catch (err) {
    if (err instanceof MachineProfilesError) {
      if (err.message === "duplicate" || err.message === "limit") return refusal("profiles.conflict", 409);
      if (err.message === "not-found") return refusal("profiles.not_found", 404);
    }
    // Neither a malformed registry nor an IO failure ever becomes an empty successful list.
    return refusal("profiles.unavailable", 503);
  }
}
