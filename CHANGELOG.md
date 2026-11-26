# Changelog

All notable changes to Agent Hub are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.18] - 2026-11-27

### Changed

- On phones, the web app moves section navigation to a bottom tab bar and shows version, connection, refresh, and settings in a compact header.

## [0.3.17] - 2026-11-27

### Fixed

- In the iOS Home Screen app the page now reaches the bottom screen edge instead of stopping one status-bar height short, so the footer sits at the bottom, and the header keeps a small gap below the status bar.

## [0.3.16] - 2026-11-26

### Added

- The web Model speed page reads generation speed and time to first token from Agent Stats, with rolling windows, grouped summaries, and model trends.

## [0.3.15] - 2026-11-26

### Changed

- The Codex credit balance is rounded to two decimals with digit grouping.

## [0.3.14] - 2026-11-26

### Fixed

- The Hub API now carries Agent Quota `credit_balance` through the server projection, so the Codex credit balance actually reaches the Quota card.

## [0.3.13] - 2026-11-26

### Added

- Quota cards show the Codex paid credit balance («Кредиты: 42.50», «без ограничений») from Agent Quota `credit_balance`; absent metadata stays hidden.

## [0.3.12] - 2026-11-26

### Fixed

- Quota cards no longer list spent reset credits (no resets left); the producer still reports them for history.

## [0.3.11] - 2026-11-26

### Changed

- Pool «Участники» renders each member with a readable Run agent exactly like its Sessions row (same component: status, title, model and folder, launch footer, link to the transcript); the separate «Подробнее» blocks are gone. Chat-pool seats now read their Run row too (they name the agent directly, without an owner binding).

## [0.3.10] - 2026-11-26

### Fixed

- The fallback Run read for pool members is projected to the member display shape, so the response no longer drops it.

## [0.3.9] - 2026-11-26

### Fixed

- Pool members read their Run status from the active Run inventory (the same source as Sessions), so live chat-pool members show «Выполняется»/«Ожидает», the model and the run footer; the per-agent read is only a fallback. An unknown runtime is no longer printed.

## [0.3.8] - 2026-11-26

### Added

- Pool «Участники» rows now read like Sessions rows: the linked Run agent's live status leads each member («Выполняется» with a spinner or «Ожидает · 12 мин (с 14:05)»), followed by the role label with the seat profile, the model and runtime, the task, and a launch/finish footer with the run time. Clicking a member opens its session transcript (history tab); seat, admission, join state, Run ID and execution lineage are collapsed under «Подробнее». Members without a linked or readable Run keep a neutral state badge and stay unlinked.
- Pool members carry the linked Run's display row (`status`, `phase`, `phase_started_at`, `idle_seconds`, model and clocks) from the verified Run proof view or a bounded Run read; the field is optional, so older payloads still decode and unlinked members report it as null.

## [0.3.7] - 2026-11-26

### Fixed

- The waiting time starts when the agent actually went idle (observation time minus Run's reported idle time), not at the last idle health check, so «Ожидает · 26 мин (с 18:48)» is consistent.

### Changed

- Working agents show how long the current step has been running and since when: «Выполняется · 12 мин (с 18:30)».
- The row footer shows the launch time and total run time («Запущен 18:30 · работает 44 мин»), or the finish time and duration for finished sessions.

## [0.3.6] - 2026-11-26

### Added

- Session rows now show what each agent is doing before its name: «Выполняется» with a spinning loader while its step runs, «Ожидает · 12 мин (с 14:05)» with the reported wait and start clock when an explicit-finish agent waits to be woken, and the lifecycle badge for finished or failed runs. The same status leads the session detail header, and agents are labelled `name (profile)` with the Run ID kept in the tooltip and details. Run `phase`, `phase_started_at` and `idle_seconds` (plus `profile`) are carried through the server into session lists, Overview «Текущие сессии» and session details; unrecognized phases keep their own neutral label. The web fixture scenario gains a waiting agent.

## [0.3.5] - 2026-11-26

### Changed

- Session transcripts and pool discussions are one continuous, virtualized message feed: newest at the bottom, older history loads on scrolling up without jumping, live messages append with a "New messages ↓" button when reading above. The pager and history window dialog are removed; export moved to Details.
## [0.3.4] - 2026-11-26

### Added

- Held-message alarm can be hidden with a close button. The dismissal is remembered in the browser for one hour and ends early when more messages are held than when it was given.

## [0.3.3] - 2026-11-26

### Fixed

- Held-message alarm: the count now comes from the Bridge observer overview `counts` (unhanded, reserved, invoking, held, review), so a new hold is never missed after a long history, and the per-message list is read newest-first. The list says when it is partial. Messages undelivered for more than 7 days no longer keep the banner red; they appear as a muted «stale» line linking to incidents.

## [0.3.2] - 2026-11-25

### Fixed

- iPhone standalone app: the bottom padding no longer adds the home-indicator inset a second time when iOS already stops the web view above that strip. The inset is measured at runtime (`--web-safe-bottom`), and Settings shows the measured screen, window, insets and gap for diagnosis.

## [0.3.1] - 2026-11-24

### Added

- Held-message alarm: a red banner on every web page (and a red line in the terminal header) when a message accepted by Bridge has waited more than 10 minutes without delivery, with the count, the oldest wait, the harness and attempts per message, and a link to Bridge incidents. The Overview Bridge card shows «Ожидает» in red with the held count. Data comes from Bridge delivery rows (custody `pending`, delivery `unhanded`/`reserved`/`invoking`/`held`/`review`) via `GET /api/v1/bridge/held`; the scan is bounded and says so when history was not fully read.

## [0.3.0] - 2026-11-24

### Added

- Quota: a "Сбросить" / "Reset" button on each group of usable banked resets (web only). It opens a confirmation naming the account, reset, what it refills and its expiry, warns that the action is irreversible, then redeems one credit through Agent Quota and follows the attempt for up to a minute. This is the Hub's first mutating action: `POST /api/v1/quota/redeem` and `GET /api/v1/quota/redeem/:request_id`, same-origin only, guarded by the `X-Agent-Hub-Action: redeem` header, JSON content type, strict validation and a double-submit guard. The native observer and the terminal client stay read-only.

## [0.2.10] - 2026-11-24

### Changed

- Quota reset credits: identical resets are grouped ("3 × Reset"), each group shows its name on one line and scope · expiry on the next, generic provider names are localized, the Overview badge uses a vector icon, and the row is hidden when Quota cannot read the inventory.

## [0.2.9] - 2026-11-24

### Added

- Quota: banked limit resets reported by Agent Quota 0.2.3 — each account card lists usable resets with what they refill and when they expire, the Overview quota rows show a ↺ count badge, and the terminal account rows show the count and soonest expiry. Unknown inventories are shown apart from a known zero.

## [0.2.8] - 2026-11-23

### Changed

- Overview: short blocks first in a compact grid (source health, Sessions counters, Bridge, Quota), the long current-sessions list last; the Quota card shows one slim pace bar per account for its most constraining window (exhausted, soonest forecast exhaustion, lowest remaining, then stale), tapping opens that account on the Quota tab.

## [0.2.7] - 2026-11-23

### Changed

- Quota forecasts show durations of a day or more as days and hours ("2 д 10 ч" instead of "58 ч"); burn rate reads "%/ч" (percentage points of the window per hour).

## [0.2.6] - 2026-11-23

### Fixed

- Installed PWA: the home-indicator inset is applied inside the rail and panes instead of the whole shell, so backgrounds reach the bottom of the area iPadOS gives the web app (the remaining strip below it is system-owned). Overview current sessions show readable titles.

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

[0.3.18]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.18
[0.3.17]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.17
[0.3.16]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.16
[0.3.15]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.15
[0.3.14]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.14
[0.3.13]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.13
[0.3.12]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.12
[0.3.11]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.11
[0.3.10]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.10
[0.3.9]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.9
[0.3.8]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.8
[0.3.7]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.7
[0.3.6]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.6
[0.3.5]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.5
[0.3.4]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.4
[0.3.3]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.3
[0.3.2]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.2
[0.3.1]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.1
[0.3.0]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.3.0
[0.2.10]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.10
[0.2.9]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.9
[0.2.8]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.8
[0.2.7]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.7
[0.2.6]: https://github.com/DKotsyuba/agent-hub/releases/tag/v0.2.6
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
