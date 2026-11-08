import { describe, expect, test } from "bun:test";

import {
  authTransport,
  forwardedProtoIsHttps,
  nextOpenLabel,
  OPEN_LABEL_ATTEMPTS,
  OPEN_LABEL_BASE,
  parseLoginRequest,
  parseOpenRequest,
  passwordWithinBody,
  sameOriginScheme,
  type AuthRequestFacts,
} from "./auth.ts";
import { PASSWORD_MAX_BYTES } from "./password.ts";

const HOST = "127.0.0.1:8787";

function facts(over: Partial<AuthRequestFacts> = {}): AuthRequestFacts {
  return {
    peerLoopback: true,
    hostLoopback: true,
    tls: false,
    proxyMarker: false,
    forwardedProto: null,
    host: HOST,
    origin: `http://${HOST}`,
    ...over,
  };
}

describe("same-origin and forwarded proto", () => {
  test("an origin must name the Host, scheme included", () => {
    expect(sameOriginScheme(`http://${HOST}`, HOST)).toBe("http");
    expect(sameOriginScheme(`https://${HOST}`, HOST)).toBe("https");
    expect(sameOriginScheme("http://127.0.0.1:9999", HOST)).toBeNull();
    expect(sameOriginScheme("null", HOST)).toBeNull();
    expect(sameOriginScheme(null, HOST)).toBeNull();
  });

  test("every non-empty forwarded proto must say https", () => {
    expect(forwardedProtoIsHttps("https")).toBe(true);
    expect(forwardedProtoIsHttps("https, https")).toBe(true);
    expect(forwardedProtoIsHttps("https,http")).toBe(false);
    expect(forwardedProtoIsHttps("http")).toBe(false);
    expect(forwardedProtoIsHttps(", ,")).toBe(false);
    expect(forwardedProtoIsHttps(null)).toBe(false);
  });
});

describe("authTransport", () => {
  test("strict loopback HTTP is accepted", () => {
    expect(authTransport(facts())).toBe("loopback");
  });

  test("a missing Origin is refused for login/open", () => {
    expect(authTransport(facts({ origin: null }))).toBeNull();
  });

  test("a cross-origin or https origin on plain loopback is refused", () => {
    expect(authTransport(facts({ origin: "https://evil.example" }))).toBeNull();
    expect(authTransport(facts({ origin: `https://${HOST}` }))).toBeNull();
  });

  test("TLS on the listener is not the strict loopback case", () => {
    expect(authTransport(facts({ tls: true }))).toBeNull();
  });

  test("a proxy marker on loopback is refused even with a matching Origin", () => {
    expect(authTransport(facts({ proxyMarker: true }))).toBeNull();
  });

  test("a co-located HTTPS front door is accepted only with every marker", () => {
    const front = facts({
      proxyMarker: true,
      forwardedProto: "https, https",
      origin: `https://${HOST}`,
    });
    expect(authTransport(front)).toBe("https-front");
    expect(authTransport({ ...front, forwardedProto: "https,http" })).toBeNull();
    expect(authTransport({ ...front, forwardedProto: null })).toBeNull();
    expect(authTransport({ ...front, proxyMarker: false })).toBeNull();
  });

  test("a client-written X-Forwarded-Proto from a remote peer proves nothing", () => {
    const remote = facts({
      peerLoopback: false,
      proxyMarker: true,
      forwardedProto: "https",
      origin: `https://${HOST}`,
    });
    expect(authTransport(remote)).toBeNull();
  });

  test("a non-loopback Host is not the strict loopback case", () => {
    expect(authTransport(facts({ hostLoopback: false }))).toBeNull();
  });

  test("the status read may omit Origin but still rejects a foreign one", () => {
    expect(authTransport(facts({ origin: null }), { requireOrigin: false })).toBe("loopback");
    expect(
      authTransport(
        facts({ origin: null, proxyMarker: true, forwardedProto: "https" }),
        { requireOrigin: false },
      ),
    ).toBe("https-front");
    expect(authTransport(facts({ origin: "https://evil.example" }), { requireOrigin: false })).toBeNull();
  });
});

describe("parseLoginRequest", () => {
  const good = { label: "  phone\n", password: "correct horse battery" };

  test("normalises the label and keeps the password byte for byte", () => {
    expect(parseLoginRequest(good)).toEqual({ ok: true, request: { label: "phone", password: good.password } });
  });

  test("refuses a body that is not an object, an absent password and a control-character label", () => {
    expect(parseLoginRequest(null)).toEqual({ ok: false, reason: "bad-request" });
    expect(parseLoginRequest([])).toEqual({ ok: false, reason: "bad-request" });
    expect(parseLoginRequest({ label: "phone" })).toEqual({ ok: false, reason: "bad-request" });
    expect(parseLoginRequest({ label: "ph\u202eone", password: "x" })).toEqual({ ok: false, reason: "bad-label" });
    expect(parseLoginRequest({ label: "", password: "x" })).toEqual({ ok: false, reason: "bad-label" });
  });

  test("an over-policy password parses and is then simply wrong", () => {
    const long = "a".repeat(PASSWORD_MAX_BYTES + 1);
    expect(parseLoginRequest({ label: "phone", password: long })).toMatchObject({ ok: true });
    expect(passwordWithinBody(long)).toBe(false);
  });
});

describe("parseOpenRequest", () => {
  test("accepts a bounded string and refuses the rest", () => {
    expect(parseOpenRequest({ guide: "x".repeat(43) })).toEqual({ guide: "x".repeat(43) });
    expect(parseOpenRequest({ guide: "" })).toBeNull();
    expect(parseOpenRequest({ guide: 1 })).toBeNull();
    expect(parseOpenRequest({ guide: "x".repeat(129) })).toBeNull();
    expect(parseOpenRequest(null)).toBeNull();
  });
});

describe("automatic labels", () => {
  test("starts at the base and numbers the next free slot", () => {
    expect(nextOpenLabel([])).toBe(OPEN_LABEL_BASE);
    expect(nextOpenLabel([OPEN_LABEL_BASE])).toBe(`${OPEN_LABEL_BASE} 2`);
    expect(nextOpenLabel([OPEN_LABEL_BASE, `${OPEN_LABEL_BASE} 2`])).toBe(`${OPEN_LABEL_BASE} 3`);
  });

  test("is bounded, so a wiped browser cannot grow the registry forever", () => {
    const taken = Array.from({ length: OPEN_LABEL_ATTEMPTS }, (_, i) =>
      i === 0 ? OPEN_LABEL_BASE : `${OPEN_LABEL_BASE} ${i + 1}`,
    );
    expect(nextOpenLabel(taken)).toBeNull();
  });
});
