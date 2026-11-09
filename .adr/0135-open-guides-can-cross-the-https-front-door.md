# 0135: Open guides can cross the HTTPS front door

- **Status:** Accepted
- **Date:** 2026-11-08
- **Supersedes:** ADR 0133 sections 4–5, only the strict-loopback restriction on guide exchange.

## Context

The operator explicitly requested using CLI-minted one-time links from another browser. Possession
of a 256-bit guide is the proof, not the browser being on the host. The former localhost-only rule
prevented this without strengthening the ordinary device token after enrolment.

## Decision

Allow `/api/auth/open` over the same strict-loopback HTTP or co-located HTTPS front door as password
login. Keep Host allowlists, same-origin Origin, front-door identity/device gates, rate limits, body
bounds, two-minute TTL, owner-only hash storage and consume-before-enrol single-use semantics. Do
not enable anonymous APIs or direct unencrypted remote enrolment.

`collie open` remains local by default. `--remote` resolves only the existing configured public URL
or Tailnet HTTPS address; arbitrary URL arguments are not accepted. Require the exact instance
mount and reject userinfo, query, fragment and non-HTTPS input before minting. `--print` explicitly
prints the credential-bearing link rather than launching a browser, with a warning on stderr. No
link is printed by default. The browser clears fragments at HTTPS origins as well as localhost.

## Consequences

Anyone holding a printed guide can enrol one full-access device until it expires. Share privately;
terminal logs, clipboard sync and screenshots may expose it. The default command remains silent
about secrets. A remote enrolment receives the same revocable token, not a permanently open route.
A trusted HTTPS ingress is still required; this does not make a plain LAN HTTP endpoint safe.
