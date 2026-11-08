# 0134: Saved machine profiles contain parameters, never trust

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** pending
- **Relates to:** ADR 0013 (a peer is not a front door), ADR 0015 (SSH installation belongs to the operator), ADR 0016 (SSH hints are not trust), ADR 0086 (reads require a device).

## Context

An operator wants other machines saved on the server so a second browser or phone sees the same
configuration. Crew already persists enrolled machine identity, addresses, pins and reconnect state;
its ops store records successfully observed SSH deployment information. Neither is a suitable place
for an unverified web form. Treating a saved URL as an enrolled machine would misrepresent security
and connectivity; letting the daemon run arbitrary SSH installers would reopen ADR 0015.

## Decision

- Add a bounded, owner-only `machine-profiles.json` in the instance state directory for explicit
  setup parameters. The HTTP surface requires ordinary paired read/write gates. Unknown fields,
  credentials in URLs, invalid SSH targets and corrupt state are rejected. No outbound request,
  credential collection, SSH key acceptance or installation occurs on save or read.
- Keep Crew trust and ops records authoritative for enrolled machines. Saving a draft does not
  create or modify either. A saved profile is visibly not a connection check.
- The host operator runs `collie crew add --saved <opaque-id>` for initial setup. It reads and
  validates the current instance's document and delegates as argv to the existing interactive
  installer, with persistence verification. No other flags or positional host are accepted with
  `--saved`; fields cannot become shell text or separate flags. Existing confirmation, known_hosts,
  pinned identity and refusal to silently take over another Crew all remain unchanged.
- Profiles hold no SSH password, private key, browser credential or membership secret. SSH uses the
  host's existing configuration and agent. Runtime reconnect uses Crew credentials, not a browser
  password or an SSH password. Profiles are shared only within the authenticated Collie instance;
  there is no automatic cross-server sync.
- Removing a profile removes only that draft. Crew removal remains a separate operator act and
  does not become a side effect of deleting convenient setup information.

## Consequences

A second authenticated browser reads the same server document; a fresh browser has no configuration
to migrate. Server restart preserves saved parameters. First-time setup still needs a host terminal
and a reachable HTTPS lead front door: `127.0.0.1` is not an address another machine can dial.
Saving is useful before either exists, but is never presented as a successful enrollment.

A fully web-driven SSH installer, password vault or direct federation of independent browser
endpoints would require a separate decision on consent, credentials, request forgery and identity.
This change deliberately does not approximate one with an unaudited command runner.
