# Releasing Agent Hub

The Linux x86-64 release requires glibc 2.39 or newer. GitHub publishes
`agent-hub-X.Y.Z-linux-x86_64.tar.gz` and `SHA256SUMS`. The archive contains
`bin/hub-server`, `bin/agent-hub`, `libexec/agent-hub-observer`, the production
browser build in `share/web/`, `share/systemd/agent-hub.service`, the connection
template in `etc/agent-hub/`, `LICENSE` and `THIRD_PARTY_NOTICES.md`.

The server finds the observer and web build beside the release's `bin/` directory.
The TUI embeds the Bun and OpenTUI runtime and connects to the server over HTTP.
The Tauri desktop application is parked.

## Prepare and verify

1. Run `node scripts/release.mjs prepare X.Y.Z` on the release branch. Add a
   dated `CHANGELOG.md` section and its GitHub release link.
2. Prepare the pinned Node, Bun and Rust toolchains, then use
   `npm ci --ignore-scripts` at the root and
   `cargo fetch --locked --manifest-path server/observer/Cargo.toml`.
3. Regenerate notices with `node scripts/generate-notices.mjs` when locked
   dependencies, web asset inputs or the Bun pin change. The generator reads
   the installed packages, cached Rust crates and pinned Bun license. Supply
   `--bun-license FILE` for offline generation or checking.
4. Run `node scripts/release.mjs check X.Y.Z` and the Linux CI gate before merging.

Set `TMPDIR`, `TMP`, `TEMP` and `npm_config_cache` to the designated task
directories. The TUI needs an owned executable temporary directory outside
`/tmp` with group and other write disabled.

```sh
node scripts/generate-notices.mjs --check
npm run build:release -- "$TMPDIR/payload"
mkdir "$TMPDIR/extracted"
tar -xzf "$TMPDIR/payload/agent-hub-X.Y.Z-linux-x86_64.tar.gz" -C "$TMPDIR/extracted"
python3 scripts/smoke-release.py "$TMPDIR/extracted/agent-hub-X.Y.Z-linux-x86_64"
```

The default output directory is `.tmp/release`. Pass an empty output directory
for each build. `build:release` builds with locked dependencies, remaps the Rust
checkout and Cargo paths, and verifies the archive layout, permissions, checksum,
TUI version and absence of local build paths. Packaging uses sorted entries,
fixed modes and numeric owners, commit-time mtimes (or `SOURCE_DATE_EPOCH`)
and `gzip -n`. This makes packaging deterministic for identical build inputs.

The extracted smoke exercises a synthetic Run producer through the release
observer and Unix listener, including health, a populated list, an SPA deep
link, SSE and the real TUI in a PTY. The CI browser smoke uses the installed
Chrome and ChromeDriver and the locked WebdriverIO dependency. These are fixture
checks. Use the Dobi acceptance steps in the design for live qualification.

## Publish and activate

The owner signs and pushes the `vX.Y.Z` tag from `main`. The workflow checks tag
ancestry and version fields and runs the source gate. An independent job builds
and smoke-tests the exact payload. The reviewed `release` environment gates
publication. The publish job attests the archive, uploads a draft, downloads
both files, verifies the archive checksum and attestation, then publishes it.

```sh
sha256sum --check SHA256SUMS
gh attestation verify agent-hub-X.Y.Z-linux-x86_64.tar.gz --repo DKotsyuba/agent-hub
```

Keep reviewed source configuration in `/etc/agent-hub/` outside the release.
The supplied unit expects `/opt/agent-hub/current` to select a whole extracted
release. Upgrade or roll back by selecting the complete release and restarting
the unit under the operator's reviewed activation procedure.
