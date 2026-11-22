# Hub server

The Bun entry point is `server/src/main.ts`. The read-only native observer
and its Cargo lockfile live in `server/observer/`.

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
