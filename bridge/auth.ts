import type { JsonObject, JsonValue } from "./json.ts";
import { normalizeLabel } from "./pairing.ts";
import { PASSWORD_MAX_BYTES } from "./password.ts";

// ── THE TWO NEW WAYS IN, AS ONE PURE DECISION ────────────────────────────────────────────────────
//
// `POST /api/auth/login` (a fixed password) and `POST /api/auth/open` (a `collie open` guide) are
// issuance channels, not a second kind of credential: both end in `PairingStore.enrol` and hand back
// an ordinary device token (ADR 0133). What this module owns is everything that must be decided
// BEFORE that enrolment — is this request from a browser at the front door at all, is the body a
// request rather than a payload, and which automatic label may `collie open` use.
//
// Pure on purpose. `Bun.serve` cannot be stood up in `bun test` (CLAUDE.md), so the transport matrix,
// the parsers and the label search are all exported functions over plain facts, and the route in
// bridge/server.ts is the thin wiring around them.

/** Where an auth request came from, once the server has translated the runtime's facts. */
export type AuthTransport = "loopback" | "https-front";

/** The facts the transport rule needs, each one already reduced to a boolean by the caller. */
export interface AuthRequestFacts {
  /** The TCP peer address, from the kernel — never a header. */
  peerLoopback: boolean;
  /** Whether the request's Host header is one of the loopback spellings. */
  hostLoopback: boolean;
  /** Whether this listener itself terminated TLS (`req.url` starts with `https:`). */
  tls: boolean;
  /** Whether the request carries any header a front door adds (`carriesProxyMarker`). */
  proxyMarker: boolean;
  /** The raw `x-forwarded-proto` value, possibly comma-joined, or null. */
  forwardedProto: string | null;
  /** The `Host` header, used for the same-origin comparison. */
  host: string;
  /** The `Origin` header. A browser sends one on every POST; its absence is refused. */
  origin: string | null;
}

/** The origin's scheme when it names the very host the request was addressed to, else null. */
export function sameOriginScheme(origin: string | null, host: string): "http" | "https" | null {
  if (origin === null || origin === "" || host === "") return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.host !== host) return null;
  return url.protocol === "https:" ? "https" : "http";
}

/**
 * Whether every non-empty `x-forwarded-proto` entry says `https`. A repeated header arrives
 * comma-joined, and a chain that mixed schemes is not an HTTPS front door — it is a request that
 * crossed a plain hop somewhere, so the whole value must agree.
 */
export function forwardedProtoIsHttps(raw: string | null): boolean {
  if (raw === null) return false;
  const parts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => part === "https");
}

/**
 * The transport rule for both new routes.
 *
 * - **loopback**: the kernel peer is loopback, the Host header is a loopback spelling, this listener
 *   did not terminate TLS, and nothing forwarded the request. The browser's `Origin` must be the
 *   same host over `http`.
 * - **https-front**: the kernel peer is loopback (the co-located front door; a remote client cannot
 *   make its own TCP peer loopback), the request carries a proxy marker and every
 *   `x-forwarded-proto` entry is `https`. The browser's `Origin` must be the same host over `https`.
 *
 * A missing `Origin` is never accepted. A client-written `X-Forwarded-Proto: https` from a
 * non-loopback peer changes nothing: the peer check comes first. `arrivedOverHttps()` stays what it
 * always was — a hint for HSTS — and is deliberately not called here.
 */
export function authTransport(
  facts: AuthRequestFacts,
  options: { requireOrigin?: boolean } = {},
): AuthTransport | null {
  const requireOrigin = options.requireOrigin ?? true;
  const hasOrigin = facts.origin !== null && facts.origin !== "";
  const scheme = hasOrigin ? sameOriginScheme(facts.origin, facts.host) : null;
  // An Origin that is present must always name this host; a missing one is only tolerated where the
  // caller asked for it (the anonymous status read, which a browser sends with no Origin on GET).
  if (hasOrigin && scheme === null) return null;
  if (!hasOrigin && requireOrigin) return null;
  if (
    facts.peerLoopback &&
    facts.hostLoopback &&
    !facts.tls &&
    !facts.proxyMarker &&
    (!hasOrigin || scheme === "http")
  ) {
    return "loopback";
  }
  if (
    facts.peerLoopback &&
    facts.proxyMarker &&
    forwardedProtoIsHttps(facts.forwardedProto) &&
    (!hasOrigin || scheme === "https")
  ) {
    return "https-front";
  }
  return null;
}

// ── Request bodies ───────────────────────────────────────────────────────────────────────────────

/** The largest auth body read: a label and a password, with room for JSON quoting. */
export const AUTH_BODY_MAX_BYTES = 4 * 1024;

/** `POST /api/auth/login` once it is a request. */
export interface LoginRequest {
  label: string;
  password: string;
}

export type LoginParse =
  | { ok: true; request: LoginRequest }
  | { ok: false; reason: "bad-request" | "bad-label" };

/** `POST /api/auth/open` once it is a request. */
export interface OpenRequest {
  guide: string;
}

/** A body that is a JSON object, or null for a scalar, an array or absence. */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/**
 * Validate an untrusted login body. The label goes through the same {@link normalizeLabel} the code
 * path uses, so a password login cannot smuggle a control character into the audit log or the device
 * list. The password is only required to be a non-empty string within the body cap: anything outside
 * the CLI's 12–256 policy is simply a wrong password, and answering "too short" here would turn the
 * login form into an oracle for the password's shape.
 */
export function parseLoginRequest(value: JsonValue | undefined): LoginParse {
  const o = asRecord(value);
  if (o === null) return { ok: false, reason: "bad-request" };
  if (typeof o.password !== "string" || o.password === "") return { ok: false, reason: "bad-request" };
  const label = normalizeLabel(o.label);
  if (label === null) return { ok: false, reason: "bad-label" };
  return { ok: true, request: { label, password: o.password } };
}

/** Validate an untrusted open body. The guide is checked for shape; its hash is checked later. */
export function parseOpenRequest(value: JsonValue | undefined): OpenRequest | null {
  const o = asRecord(value);
  if (o === null) return null;
  if (typeof o.guide !== "string" || o.guide.length === 0 || o.guide.length > 128) return null;
  return { guide: o.guide };
}

/** Whether a password is too large to bother hashing. Kept here so the route and tests agree. */
export function passwordWithinBody(password: string): boolean {
  return Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_BYTES;
}

// ── Automatic labels for `collie open` ──────────────────────────────────────────────────────────

/** The first automatic label. Numbered ones follow (`Local browser 2`, …). */
export const OPEN_LABEL_BASE = "Local browser";
/** How many numbered variants are tried before the route refuses with `label-unavailable`. */
export const OPEN_LABEL_ATTEMPTS = 20;

/**
 * The first unused label in the small automatic space, or null when all of them are taken.
 *
 * `collie open` asks for no device name, so the bridge names the browser. A password login already
 * refuses a live duplicate label, and this path obeys the same rule: it picks a free one rather than
 * replacing a device it cannot identify. The space is bounded so a wiped browser cannot grow the
 * registry by a fresh label forever; hitting the bound is a refusal the person can act on.
 */
export function nextOpenLabel(
  existing: readonly string[],
  base: string = OPEN_LABEL_BASE,
  attempts: number = OPEN_LABEL_ATTEMPTS,
): string | null {
  const taken = new Set(existing);
  for (let n = 1; n <= attempts; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    // A base long enough to fail `normalizeLabel` must not silently produce an unusable label.
    if (normalizeLabel(candidate) === null) continue;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Why a login was refused. Mapped to a wire code by the route; no reason reveals the password. */
export type LoginFailure =
  | "not-configured"
  | "incorrect"
  | "unavailable"
  | "duplicate-label"
  | "device-limit";

/** Why an open exchange was refused. `label-unavailable` is the exhausted automatic space. */
export type OpenFailure =
  | "no-guide"
  | "expired"
  | "bad-token"
  | "duplicate-label"
  | "device-limit"
  | "label-unavailable";

/** The public answer to `GET /api/auth/status`: whether a password is usable, and nothing else. */
export interface AuthStatusBody {
  configured: boolean;
}
