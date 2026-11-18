# Releasing Agent Hub

A release is the Linux x86-64 (glibc) terminal Hub, published by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed. The desktop (Tauri) application is parked and is never built or released, and the standalone build supports Linux x64 only, so there is no macOS asset.

## Assets

| Asset | Content |
|---|---|
| `agent-hub-X.Y.Z-linux-x86_64.tar.gz` | `agent-hub`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `etc/agent-hub/connections.json`; sorted entries, root ownership, commit-time mtimes, `gzip -n` |
| `agent-hub-linux-x86_64` | the bare executable (identical to the archived one) |
| `THIRD_PARTY_NOTICES.md` | license texts of the embedded Bun, OpenTUI, npm and Rust components |
| `SHA256SUMS` | SHA-256 of the three files above; the attestation covers exactly these three listed files (`SHA256SUMS` is the inventory, not an attestation subject) |

## Prepare

1. Start from an up-to-date `main` on a release branch: `git switch -c release/vX.Y.Z origin/main`.
2. `node scripts/release.mjs prepare X.Y.Z` bumps every version field (root and terminal `package.json`/lockfiles, observer and Tauri `Cargo.toml`/`Cargo.lock`, `tauri.conf.json`) with minimal in-place edits.
3. Add `## [X.Y.Z] - YYYY-MM-DD` and its `[X.Y.Z]: https://github.com/DKotsyuba/agent-hub/releases/tag/vX.Y.Z` link to `CHANGELOG.md`; the section becomes the release notes.
4. If `terminal/package-lock.json`, `terminal/observer/Cargo.lock` or the Bun pin changed, regenerate the notices (below).
5. `node scripts/release.mjs check X.Y.Z` must pass; open a pull request and merge it into `main` after Linux CI passes.

## Third-party notices

`node scripts/generate-notices.mjs` rewrites `THIRD_PARTY_NOTICES.md` and `--check` verifies it is current (CI and the release gate run the check). It needs `npm ci --ignore-scripts` in `terminal/`, `cargo fetch --locked --manifest-path terminal/observer/Cargo.toml` and network access for the pinned Bun `LICENSE.md` (or `--bun-license FILE`). The output depends only on those inputs: no timestamps or local paths. A new, unlisted notice file in an OpenTUI package, or a dependency without a license file, fails generation so that it is reviewed. `BUN_VERSION` in the script must equal the Bun pin in the workflows and `terminal/package.json`.

## Publish

1. Tag the merged `main` commit and push the tag (the owner signs it): `git tag -s vX.Y.Z -m "Agent Hub X.Y.Z" && git push origin vX.Y.Z`.
2. The workflow runs three jobs. `check` (source gate: tag/version/changelog/main-ancestry consistency, notices up to date, typecheck, Rust fmt/clippy/tests, standalone build, Bun and Node suites) and `build` (no credentials) run in parallel. `publish` needs both, uses the `release` environment (configure required reviewers on it in the repository settings), attests the three files listed in `SHA256SUMS`, creates a **draft** release with the assets, downloads them again, re-checks the hashes and attestations, and only then publishes it.
3. After publication, verify a download: `sha256sum --check --ignore-missing SHA256SUMS` and `gh attestation verify <asset> --repo DKotsyuba/agent-hub` for each of the three assets (for example `agent-hub-linux-x86_64`).

## No local paths in binaries

The build job sets `RUSTFLAGS` with `--remap-path-prefix` for the checkout (`/build/agent-hub`) and Cargo home (`/cargo`), and `release.mjs verify` fails when the executable contains `/home/`, `/Users/`, the checkout, the runner temporary directory or Cargo home. Reproduce locally:

```sh
repository="$(git rev-parse --show-toplevel)"
(cd terminal && RUSTFLAGS="--remap-path-prefix=$repository=/build/agent-hub --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" npm run build:binary)
node scripts/release.mjs package X.Y.Z terminal/dist/agent-hub "$TMPDIR/payload" --epoch "$(git log -1 --format=%ct)"
node scripts/release.mjs verify X.Y.Z "$TMPDIR/payload"
```

The Bun runtime build is not claimed to be bit-for-bit reproducible; only the archive packaging is deterministic for a given executable.

## Local helper commands

`node scripts/release.mjs notes X.Y.Z` prints the release notes; `package` and `verify` take the arguments shown in the header of the script.
