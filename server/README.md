# Hub server

The Bun entry point is `server/src/main.ts`. The read-only native observer
and its Cargo lockfile live in `server/observer/`.

The server has one mutating action, redeeming a banked Quota reset credit
(`server/src/redeem.ts`). It does not go through the observer, which stays
strictly read-only: a separate narrow client sends only `redeem_reset_credit`
and `redeem_status` on the Quota socket resolved from the same connection
configuration (`AGENT_HUB_CONFIG`, per-user, `/etc/agent-hub/connections.json`,
Linux default `/run/agent-quota/quota.sock`, UID 999).

- `POST /api/v1/quota/redeem` with JSON `{"account","credit_id"}` returns the
  Quota record `{request_id, account, credit_id, state, reason, created_at,
  updated_at}`. The server generates the UUID v4 `request_id`. Requirements:
  an `Origin` equal to the configured public or loopback origin, the header
  `X-Agent-Hub-Action: redeem`, `Content-Type: application/json`, no query,
  at most 1 KiB, exactly the two fields. Refusals return 403 `forbidden`
  (missing Origin or action header, cross-site `Sec-Fetch-Site`, Quota
  permission error) or 400 `invalid_request`.
- `GET /api/v1/quota/redeem/:request_id` returns the same record.
- A second submission for the same account and credit while an attempt is
  pending, unknown or redeemed returns that attempt instead of creating one.
  Transport errors after a request may have been sent yield `state: "unknown"`
  and are never resent under a new ID; a connection failure before sending
  yields `state: "failed"`, `reason: "quota_unavailable"`.
- Each attempt logs one `quota_redeem` JSON line (account, credit ID, request
  ID, outcome).

Compile the server for a release with Bun 1.4.4.

```sh
bun build --compile --outfile <release>/bin/hub-server server/src/main.ts
```

The compiled server resolves the observer at `libexec/agent-hub-observer`
and the Vite build at `share/web`, relative to its release directory.
`server/systemd/agent-hub.service` configures the service account, temporary
directory, source settings and Unix socket. Set `AGENT_HUB_PUBLIC_ORIGIN`
to the public HTTPS origin before connecting an HTTPS gateway. Local Unix
HTTP clients send `Host: localhost`.

Run from source with `bun --no-install server/src/main.ts --unix /absolute/socket`.
The socket parent must be owned by the invoking user and primary group with
mode `0750`. The source entry resolves the observer from the Cargo debug
target (respecting `CARGO_TARGET_DIR`) and serves the root `dist/` build.
For isolated development, `--dev-loopback PORT` binds `127.0.0.1`
and expects a matching Host header. Synthetic API scenarios are available
through the separate fixture service in `packages/client/fixtures/`.

Set `TMPDIR`, `TMP`, `TEMP` and `npm_config_cache` to the designated task
scratch paths for verification. Use the prepared npm dependencies and offline
Cargo cache.

```sh
npm run typecheck
bun test --no-install server/test
npm run test:contract
cargo fmt --manifest-path server/observer/Cargo.toml --check
cargo clippy --manifest-path server/observer/Cargo.toml --offline --locked --all-targets -- -D warnings
cargo nextest run --manifest-path server/observer/Cargo.toml -p agent-hub-observer --offline --locked
```

API cursor signing keys are process-local. After a restart, old continuations
return `stale_boundary` and the client can reload the relevant edge. SSE sends
invalidations and source state, while HTTP GET responses carry the history
positions clients use to catch up.

A failed native read emits one `source_failure` line per underlying operation.
The line uses the route and request ID of the HTTP request or SSE poll that
started the operation. Requests sharing that read do not emit additional lines.
If a projector rejects a usable envelope, its first rejection emits the line
for that read. Admission limits and subscriber cancellations do not count as
native read failures. Logs carry a classified error, never producer diagnostics
or payloads.
