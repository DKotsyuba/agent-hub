# Changelog

All notable changes to Agent Hub are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-15

First public release: the terminal Hub for Linux x86-64 (standalone executable). The desktop (Tauri) application is retained in the repository but is parked and not released.

### Added

- Terminal interface (OpenTUI on Bun) with read-only views: Run and Bridge overview, Sessions (history, tool calls, exact initial task, export), Agent Pool (members, journal, proposals, votes, deliveries, completion records), Quota and Worktree.
- Quota tab and Overview card: one block per account with progress bars, even-burn marker, reserve/deficit and projected run-out; reads the Agent Quota service directly.
- Worktree tab: project cards with on-disk size, uncommitted changes, merge state and linked Run sessions, backed by `agent-worktree mcp` read calls only.
- Pool group observer socket and frozen completion records.
- Linux defaults: shared Run broker `/run/agent-mcp/api.sock`, host-wide configuration `/etc/agent-hub/connections.json` (Dobi reference-host template in `packaging/etc/agent-hub/`).
- Standalone executable build (`bun scripts/build-binary.mjs` in `terminal/`) embedding Bun 1.4.4, OpenTUI 0.8.2 and the Rust observer.
- `THIRD_PARTY_NOTICES.md` with the license texts of the bundled components.
- Linux CI for the terminal: typecheck, Rust format/clippy/tests, standalone build, Bun and Node suites.

### Changed

- Dependencies updated; `rmcp` 3.9.0 and `tokio` 1.54.1 fix RUSTSEC-2026-0457, -0461, -0462 and -0384 in the observer.

### Removed

- Archived Tasks and IDE sources are denied by the observer; the terminal has no Tasks, IDE or Run info tabs.

[0.1.0]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.0
