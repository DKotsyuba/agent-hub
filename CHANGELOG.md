# Changelog

All notable changes to Agent Hub are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.5] - 2026-11-23

### Changed

- Native-feeling PWA on iOS/iPadOS: the installed app reserves exactly the system status-bar inset (plus side and home-indicator insets), the shell is fixed full-screen with no page-level scrolling, bounce or pull-to-refresh (only inner panes scroll, with contained overscroll), no pinch or double-tap zoom, ≥16 px inputs, no tap highlight or callouts on chrome while message text stays selectable.

## [0.2.4] - 2026-11-23

### Fixed

- Pools completed by agreement but not yet closed no longer count as Live. The API adds `state=live|finished` (applied before pagination, `open|closed` kept); web and TUI show them under Finished as «Завершён», separate from «Закрыт», and Live counts agree.

## [0.2.3] - 2026-11-23

### Changed

- iPad-first layout: collapsible sidebar (icon rail on tablets, remembered per device), compact one-line detail header with readable titles and copyable IDs, collapsible session/pool list, and the session history and pool chat as one full-height scroll surface with compact inline tool-call rows, condensed paging and a floating new-messages control.

## [0.2.2] - 2026-11-23

### Added

- Web Quota windows show the TUI's depletion pace: an even-burn marker on the bar, green/amber/red tone, reserve or deficit with exhaustion forecast, burn rate and risk badge; unknown or stale forecasts say so without a marker. Overview shows the earliest window projected to run out before its reset. The pace calculation is shared with the TUI.

## [0.2.1] - 2026-11-23

### Changed

- Web UI redesign after the owner's phone review: page and card padding with safe-area insets, compact top navigation, one source-health strip on Overview (no duplicates), running sessions first, readable account and model names, one compact card per Quota account (window bars, relative resets, models and diagnostics collapsed, Russian labels), cleaner Sessions, Pools, Pool chat and Worktree layouts. Review: docs/design/web-ui-review.md.

### Added

- Installable PWA: manifests for light and dark, icons incl. maskable and apple-touch-icon, a build-fingerprinted service worker (`/sw.js`) that precaches the app shell and assets, keeps API and SSE network-only, and shows a clear offline state.
- Muted footer with web and server versions, connection state and refresh age; a header "Обновить" indicator when a new service worker is waiting or the server release differs, which activates the update and reloads.

## [0.2.0] - 2026-11-22

### Added

- A read-only Hub server serves the v1 HTTP API, live invalidations and the localized web UI.
- The Linux release archive includes the server, TUI, native observer, web assets, a systemd unit and a connection template.

### Changed

- **Breaking:** The TUI now requires a running compatible `hub-server` for live data. It connects over HTTP using a local Unix socket by default.
- The browser and terminal share the v1 client and presentation helpers. Chat seats can link to a Run session with its reported verification status.

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

[0.2.5]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.5
[0.2.4]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.4
[0.2.3]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.3
[0.2.2]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.2
[0.2.1]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.1
[0.2.0]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.0
[0.1.3]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.3
[0.1.2]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.2
[0.1.1]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.1
[0.1.0]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.1.0
