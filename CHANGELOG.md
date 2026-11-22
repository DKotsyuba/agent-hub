# Changelog

All notable changes to Agent Hub are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-11-22

### Changed

- Pools tab now matches Sessions: a list on the left with a "Live" section for active pools (running spinner, seat count, latest event, warnings when a member finished or a notice was undeliverable) and a collapsed "Finished" section (`o`) for completed and closed pools; the right pane shows the selected pool's header and its chat history (authors, kinds, multipart messages merged, long bodies expandable, live follow). Private direct-message delivery rows stay hidden from group observers. Sessions rows of chat pool members show their pool name.
- Quota tab shows readable account titles (Claude subscription, Codex (ChatGPT), Z.AI GLM, OpenCode Go, …) with the account ID as a muted subtitle; collector source names moved out of the card header.

## [0.1.2] - 2026-11-19

### Added

- Pools tab: Pool chat v1. Rows and details that report `kind` show `chat pool` or `managed pool (legacy)` and, when `completion_id` is reported, `completed`. A chat pool lists its seats with profile, admission (`pending`/`admitted`/`refused`/`unknown`), join state and Run agent ID; Enter or a click opens that agent in Sessions when it is in the loaded Run inventory. `l` opens the chat agreement (`completion_get` header: result, proposal, roster key, per-seat ballots with Run agent links) or, for managed pools, the existing frozen completion record. A reported `completion_id` is used directly and an explicit `null` reads nothing; without it the ID still comes from the `pool_completed` journal event, which now also recognises the agreement wording. Observers without the new fields keep the previous display. Written against the Pool owner's stated observer fields (`kind`, `completion_id`, and `seat_id`, `run_agent_id`, `profile`, `admission`, `joined` per seat); not yet exercised against a running Pool.

## [0.1.1] - 2026-11-18

### Added

- Release workflow (`.github/workflows/release.yml`): source gate, independent build with `--remap-path-prefix`, `SHA256SUMS`, artifact attestation and draft-verified publication on `vX.Y.Z` tags; `scripts/release.mjs` (prepare, check, notes, package, verify), `scripts/generate-notices.mjs` (reproducible `THIRD_PARTY_NOTICES.md`) and `RELEASING.md`.

### Changed

- Pools tab: closed pools are collapsed by default behind a `Closed · N loaded` header (count stays visible); `o` or a click shows or hides them.

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

[0.1.3]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.3
[0.1.2]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.2
[0.1.1]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.0
