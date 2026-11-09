# 0133: A shared password mints a device token, never a second API credential

- **Status:** Accepted; strict-loopback-only open exchange superseded by [ADR 0135](./0135-open-guides-can-cross-the-https-front-door.md).
- **Date:** 2026-11-08
- **Shipped in:** pending
- **Relates to:** [ADR 0086](./0086-reads-need-the-pairing-token.md) (reads need the pairing token;
  this ADR adds an issuance channel and does not relax that gate), [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md)
  (network position is not identity).
- **Trail:** `openspec/changes/password-device-access/implementation-brief.md` — an operator asked for
  a fixed web password so a remote browser need not run `collie pair` and type a code, and for
  `collie open` to skip the code entirely on the host. The other road considered was to accept the
  password itself as the bearer for every request; that is rejected below. Reaches
  `bridge/password.ts` · `bridge/open-guide.ts` · `bridge/auth.ts` · `bridge/owner-file.ts` ·
  `bridge/pairing.ts` · `bridge/server.ts` (`OPEN_API_ROUTES`, `/api/auth/*`) · `cli/password.ts` ·
  `cli/open.ts` · `web/src/lib/open-boot.ts` · `web/src/lib/access-login.ts` ·
  `web/src/components/access-sign-in.tsx`.

## Context

Collie has exactly one kind of daily credential: a 256-bit bearer token minted when a device spends
a one-time code, stored only as a SHA-256 in `<stateDir>/paired-devices.json`, checked on every
`/api/*` request by ADR 0086's gate. The code is minted by `collie pair` on the host, so enrolment
bootstraps from the one party that can already prove it is the operator: the shell.

Two frictions followed:

- A remote browser that clears storage, changes phone, or lets its token expire needs the host
  terminal again. An operator who opens Collie from a browser away from the machine cannot do that
  without reaching the machine first.
- On the host itself, running `collie pair`, scanning a QR and typing a name is more steps than the
  situation needs. The person already has the shell; the browser is one command away.

A fixed password answers the first. A CLI-opened URL answers the second. The tempting simplification
is to make the password itself the API credential: one string, no registry, no per-device row. That
would put a long-lived shared secret on every request, make revocation impossible without changing it
for everyone, and make the audit trail a single name. It also cannot express the existing token
lifetime rules, the "expired device stays listed" recovery, or the per-device launcher cleanup.

## Decision

**1. The password is a bootstrap. It issues an ordinary device token and nothing else.** A successful
`POST /api/auth/login` runs the same enrolment path as `/api/pair`: a fresh 256-bit random token,
only its SHA-256 written to `paired-devices.json`, the same optional expiry, the same label rules,
the same `device.revoke` audit and launcher cleanup. The password is never written to the registry
and is never accepted as an `Authorization` value.

**2. The browser keeps a device token, not the password.** The password is typed once, never stored
by the page, and the token is stored in the existing `collie:device-token` key. A reload, a PWA
reopen and an offline start all use the token, exactly as a paired device does. Changing or clearing
the password therefore does not sign anyone out; revocation is per device, as before.

**3. The password is managed only from the host CLI.** `collie password set` (hidden TTY input twice,
or `set --stdin` for automation), `status`, `clear`. No argv or environment password. The file
`<stateDir>/access-password.json` holds a scrypt verifier with a random salt, a fixed parameter
whitelist and 0600 atomic writes; it never holds the password. A file that is present but unreadable
or outside the whitelist is `unavailable`, never `not configured`, and `set` refuses to overwrite it
without an explicit operator action.

**4. `collie open` uses a different short-lived secret, for the same purpose.** The CLI mints a
256-bit guide, stores only its hash in `<stateDir>/open-pending.json` with a two-minute TTL, opens
`http://127.0.0.1:<port><basePath>#collie-open=<guide>` through the platform opener, and never prints
the URL. The fragment is a fragment so it is not sent to the server with the page, not written to a
proxy's access log, and not kept in history once the page clears it. The front end captures and
clears it before React Router starts, then exchanges it once for a device token. Holding no guide
gets nothing: being on localhost, being a browser, sending a header or the registry being empty are
not proof. **The exchange is strict loopback only.** Unlike password login, it is not offered through
an HTTPS front door: `collie open` names `127.0.0.1` and the guide is for the browser on that host,
so a proxied or forwarded request is refused even when its peer is loopback and its
`X-Forwarded-Proto` says `https`.

**5. Every new entry point keeps the existing front door.** `GET /api/auth/status`,
`POST /api/auth/login` and `POST /api/auth/open` join `OPEN_API_ROUTES` because they are how a device
gets a credential, exactly as `POST /api/pair` is. Each runs `checkAccess` itself, reuses the
per-source limiter and the queue bound on scrypt, and answers with `cache-control: no-store`.
Password login and the open exchange require the browser's same-origin `Origin` and are allowed only
over a strict loopback HTTP request or, for login, through a co-located HTTPS front door whose peer
is loopback; the open exchange accepts the loopback case only. The status read is a `GET`, where a
browser omits `Origin` on same-origin navigation, so it permits a missing `Origin` and still rejects
one that names another host; it is subject to the same peer/transport rule and returns `503` when a
verifier file exists but is damaged, never `configured: false`. A client-supplied
`X-Forwarded-Proto` from any other peer is ignored, not trusted. The existing `arrivedOverHttps()`
stays a hint for HSTS and never becomes an admission rule.

**6. A live duplicate label is refused; an expired one is replaced.** A password login names the
device. If a live device already holds that name the answer is `409 duplicate-label`, never a silent
replacement: the person who merely knows the password must not be able to revoke a working phone. An
expired holder is replaced in the same registry write, with the existing revoke audit and launcher
cleanup, because its token already authenticates as nobody. The registry is capped at 64 devices.

## Consequences

- **The password is one factor, not an identity.** Two people who know it are indistinguishable
  except by the device names they choose. The audit trail names a label, and the operator revokes a
  label, not a person. That is accepted for a single-operator product; a multi-user deployment needs
  separate identities, not a shared string.
- **A leaked password is a bootstrap for as long as it stands.** Clearing it stops future logins and
  does not revoke issued tokens; the operator must revoke devices separately. The docs say both
  halves plainly, because "I cleared the password" is not the same as "that device is gone".
- **A local process can still reach loopback.** The same residual ADR 0086 accepted for the local
  credential applies: a relay on the host can make a remote caller look loopback. The password (or
  the unguessable one-time guide) remains required, so the relay alone grants nothing.
- **`collie open` can create a device row on every use from a browser that lost its token.** The
  front end checks the existing token first and discards a guide when it is valid, so a normal reopen
  adds nothing; a wiped browser adds one bounded row, and the auto-label space and registry cap stop
  it growing without limit.
- **No `disable auth` switch.** An empty registry, a cleared password and a missing guide all refuse;
  the way back in stays the host terminal. Revisit only with a named route and its own ADR, never by
  reopening this decision as a relaxed gate.
