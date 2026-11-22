# Agent Hub

Agent Hub serves read-only Sessions, Agent Pool, Quota, Worktree and Bridge observations through a Unix HTTP server. The web UI and OpenTUI client share the same v1 API. The earlier desktop prototype remains available below.

## Installing a release

Each GitHub release publishes `agent-hub-<version>-linux-x86_64.tar.gz` and
`SHA256SUMS`. The archive includes both clients, the server, the observer,
a systemd unit, a connection template and license material. It requires
Linux x86-64 with glibc 2.39 or newer.

```sh
sha256sum --check SHA256SUMS
```

See [RELEASING.md](RELEASING.md) for the archive layout and activation procedure.

`packaging/etc/agent-hub/connections.json` is the host-wide default for the Dobi reference host. Copy it to `/etc/agent-hub/connections.json` on a machine that runs the same services:

| Source | Socket | Trusted UID |
|---|---|---|
| Agent Run broker (`run`) | `/run/agent-mcp/api.sock` | 1003 |
| Agent Quota (`quota`) | `/run/agent-quota/quota.sock` | 999 |
| Agent Pool group observer (`pool`) | `/run/agent-pool/observer.sock` | 1003 |

The UIDs are specific to Dobi; on any other host set the real sockets and server UIDs, or use `AGENT_HUB_CONFIG` or `~/.config/dev.agent-mcp.hub/connections.json`, which take precedence. The user running Hub must hold the groups that grant access to these sockets (for example `agent-run`).

## Terminal interface

Use Bun 1.4.4 and the pinned Rust toolchain for development. Build the observer
from the root workspace before running the server from source.

```sh
npm ci --ignore-scripts
npm run observer:build
npm run web:build
npm run terminal -- --demo
```

See [the server README](server/README.md) for a source-mode Unix listener.
The TUI defaults to `/run/agent-hub-http/http.sock` and accepts an explicit
`--server https://hub.example` origin. `--demo` selects synthetic observations;
a live disconnection remains visible and the TUI retries its Hub endpoint.
Source connection settings belong to the server. The compiled TUI extracts its
OpenTUI library into an owned executable runtime directory at startup and cleans
it up on exit. Set `TMPDIR` to a private writable directory outside `/tmp` if needed.

On Linux the configuration is read from `AGENT_HUB_CONFIG` if set (never falling back), otherwise `~/.config/dev.agent-mcp.hub/connections.json`, otherwise the host-wide `/etc/agent-hub/connections.json` (the template in `packaging/etc/agent-hub/connections.json` is the Dobi reference-host default, see [Installing a release](#installing-a-release)). With no file, or a file without `run.socket`, Linux Run defaults to the shared broker `/run/agent-mcp/api.sock` trusted as UID 1003; the server process must hold the `agent-run` group (check with `id`). A Run card error shows its code, and socket/group failures add a hint. To use an authorized shared Run socket, set its absolute path and the broker's trusted Unix UID explicitly:

```json
{"schema_version":1,"run":{"socket":"/absolute/path/to/api.sock","broker_uid":1000},"pool":{"config":"/absolute/path/to/pool.toml"},"bridge":{"config":"/absolute/path/to/interfaces.toml"}}
```

Omitting `broker_uid` retains the private same-user socket policy. The configured UID must own the socket and its parent and must match the connected peer; the parent cannot be group/world writable and the socket cannot be world accessible. Pool's configuration requires its separate owner observer credential and a running resident; the UI does not provision either. Bridge's interfaces configuration must have an `[observer]` credential backed by a dedicated diagnostics-only grant in the running Bridge service. Neither observer uses participant credentials instead.

**Quota** (tab `3`, plus an Overview card) reads the Agent Quota service directly: protocol 1, snapshot schema 2, methods `status` and `snapshot`. Linux defaults to `/run/agent-quota/quota.sock` with service UID 999; override with `"quota":{"socket":ABS,"server_uid":N}` (both are required together). The socket owner, its parent directory and the connected peer must all be the configured UID, and the socket must not be world accessible; the reader needs the socket's group (`agent-run` on the reference host) and must be allowlisted by the service. The tab shows one block per account (provider/source, OK / AT RISK / EXHAUSTED / UNKNOWN badge, freshness, red when stale) with one row per window: title, percent left, reset countdown, a `█`/`░` bar with a `┃` marker where an even burn would be now (derived from the window length and reset clock; omitted when unknown), and a reserve/deficit subline with the projected run-out. Models sharing a window are listed once; a model row repeats only when its values differ. Advice, active latches and failed sources appear as short warning lines. Technical details (revision, score, evidence, validity, burn, sources, external-ingest ages) are collapsed: press `d` or Enter on the Quota tab to expand them. The Overview card shows one line per account with a mini bar of its most constraining window. A missing value is shown as Unknown and is never treated as zero; an unsupported snapshot schema or unknown state value rejects the whole snapshot.

**Worktree** (tab `4`) runs the configured `agent-worktree mcp` frontend once per read and calls only `get_status`, `list_worktrees` and `inspect_worktree` (no create/remove/prune). It lists each repository in `connections.json` `repositories`, or every repository Worktree knows when none are configured, up to 200 rows per repository, as one card per project: a block per worktree with its directory name and branch, on-disk size, uncommitted changes (`clean` or `N changes` with a modified/staged/new breakdown), a `[MERGED]` / `[NOT MERGED]` / `[UNKNOWN]` badge (ancestry against the main checkout's branch; squash merges are not detected), plain-word activity and the number of linked Run sessions. Worktrees that need attention (unmerged with changes, then unmerged, then large or unknown) come first. Size and changes are not part of the cheap list: while the tab is open, one bounded `inspect_worktree` per worktree (`checks: {status, size}`; agent-worktree caps the walk by deadline and entry count, never follows symlinks, and reports `≥` lower bounds) runs in the background, nearest the selection first, and is cached for ten minutes, so the 3 s poll never rescans a disk; `s` measures again. The list's page-wide `size` flag stays denied. agent-worktree does not report ahead/behind counts, so none are shown. `d` shows the raw producer codes. Enter opens the inspect detail; Run sessions are linked to the most specific listed worktree that contains their workdir, and Enter on a linked session opens it. `worktree.program` defaults to `~/.local/bin/agent-worktree`; `worktree.home` sets `AGENT_WORKTREE_HOME`.

**Pool** on Linux defaults to Agent Pool's read-only group observer socket `/run/agent-pool/observer.sock` (capability `observer_socket_v1`) with resident UID 1003; override with `"pool":{"socket":ABS,"server_uid":N}`, or set `pool.program`/`pool.config` to use the owner observer program instead. Before connecting, Hub requires every ancestor directory to be owned by root or the server UID without group/other write, the socket directory and socket to deny other access, and the connected peer to be the server UID. The socket serves no bindings or Run proofs, so those views are hidden on this route. Closed pools are history: the list shows open pools and a collapsed `Closed · N loaded` header with its count, and `o` (or clicking the header) shows or hides the closed ones. Pools shows Open/Completed totals when Pool reports its completion ledger (`inventory_completion_v1`); in a pool, `l` opens the frozen completion record (`completion_record_v1`): header, SHA-256-verified goal/criteria/result/snapshot, roster, ballots, Run facts and notice, all bound to one record digest. Chat pools (Pool chat v1, ordinary Run agents as seats) are tagged `chat pool` in the list and show their seats with profile, admission, join state and Run agent in the Members tab (Enter opens the agent in Sessions); `l` on a chat pool opens its agreement record instead: result, proposal, roster key and per-seat ballots with Run agent links. The agreement carries no content digest, so its result is labeled as recorded by Pool and not as verified. Managed pools stay labeled `managed pool (legacy)`; observers that omit the chat fields keep the previous display. `pool.enrollment_get` is readable but has no view yet.

Press `?` for keys and `,` for appearance. Click the polling control or press `u` to cycle the visible view's read-only polling through 1, 3, 5 and 10 seconds; it starts at 3 seconds each time the application opens. Press `r` to refresh immediately. Session rows show the reasoning effort reported by Run; `—` means no value was reported. History pairs tool calls and results by their reported reference and name; expand a row to see input and output. A tool row shows source start and result times in local time with seconds, plus their elapsed time when both are known. Unmatched results remain separate. Long messages use `[` and `]` to change the displayed part; the complete source content remains available. Overview scans at most 20 Bridge pages per refresh and labels a bounded scan partial. An answer is shown only when its execution sequence and digest can be verified, including source support for `answer_chunk`. Copying a Run session scans retained lineage through a fixed cursor; concurrent source retention can still remove earlier records, so that export explicitly does not claim complete coverage. Clipboard submission depends on terminal support.

Sessions open at the beginning of retained history. The first retained user message is not proof of the original task, so the view marks it unverified until a source can establish it. The viewport fills from available pages, and scrolling loads later pages; press `G` to follow the latest messages.

Pass a project directory as a positional argument to start with its path-derived worktree group, or `--pool ID` to open a standalone pool directly. The former `--home`, `--socket` and `--broker-uid` options have moved to the server's source configuration. Use `--version` to display the Hub version. On older Run brokers that explicitly reject grouped transcript options, Hub reads raw forward pages instead; unrelated read failures are not treated as a compatibility fallback.

The server reads Pool through the configured observer. Its members, journal, proposals, votes and deliveries are independent source sections; managed bindings carry the source-reported identity, and chat seat links can open a reported Run ID with an unverified label. Sequence reuse after retention means that match alone does not prove historical execution identity. If Run reports the direct status method unavailable, Hub searches at most 32 revision-fenced inventory pages and rechecks that compatibility scan every 30 seconds, or on `r`. When the observer advertises `history_window_v1`, discussion starts at the latest events, `g` loads earlier events, `f`/`G` resumes following, and `y` copies a journal snapshot through its source watermark. Older observers retain forward-only page navigation and do not support snapshot copy. The optional `structured_acceptance_v1` capability exposes criteria and explicitly attributed vote checks. Historical timestamps are not supplied by Pool v1.

The Pool list groups matching loaded records as Open and Closed; these counts are not source-wide totals, and closure does not establish execution completion. When the observer advertises `inventory_snapshot_v1`, a separate line shows exact source-wide retained and closed totals with their snapshot revision; Open and Completed stay unavailable until the source has a completion ledger, and are never derived from closure. On an accepted replacement in Deliveries, Enter or click opens the former member's available Run lineage after rechecking its exact Pool binding. Transcript and answer attribution remain unverified. When Run advertises its exact transcript read, `y` copies a single historical execution only with a freshly verified store, execution reference and active history pin. Incomplete or unverifiable content is refused; the snapshot does not prove current completion or authorship.

When Run advertises `initial_task`, the session's exact initial task is fetched in verified pages and shown under Details only after its total length and SHA-256 match; the History footer then reads `Initial task verified (strict|current)`. Strict requires a store-fenced, pinned, complete Pool binding of sequence 1; current proves only the retained root and makes no pin, coverage or older-binding claim. Any unavailable, mismatched or failed read, or a Run without the capability, keeps `Initial task unverified · showing retained history` (with the reason when a read was attempted); the first retained user message is never presented as the task.

Long Pool messages are reassembled only from matching source parts; incomplete groups remain marked and cannot be copied as complete. With `content_pages_v1`, `e` opens the full purpose and `s` opens the selected proposal snapshot; all byte pages must pass the same revision fence before the text is shown.

For local checks, build the observer first, set `TMPDIR`, `TMP` and `TEMP` to an explicit writable task directory, then run `npm run typecheck` and `npm test` from `terminal/`. Tests use isolated fixtures rather than a live service.

A readable local desktop observer for the Agent MCP family. The accepted React + TypeScript + shadcn/ui interface connects to local tools through the closed Tauri 2 read surface. English and Russian interface localization preserves original task/message/result text.

The owner approved the prototype and the read-only Tauri integration milestone on 2026-10-20. Scope is read-only observation; no agent launches, task generation, runtime control or worktree mutations.

## Local development

Use Node 24+ and npm. Root provisions dependencies with install scripts disabled. Run npm run dev for the fixed loopback preview on port 4173; browser demonstration requires the explicit ?demo=1 selection; npm run typecheck and npm run build verify the frontend.

## Source provenance

Official shadcn/ui components in src/components/ui are unmodified registry sources; see docs/shadcn-provenance.json and docs/SHADCN-LICENSE.md. UI-specific styling lives outside those files.

## Navigation and acceptance

Object details replace the list at every window width. Back and browser Back/Forward retain context; related objects have their own detail screens. Agent rows use one consistent full-width hover/focus/click target.

Run npm run preview after building to serve the reviewed production bundle on http://127.0.0.1:4173. Browser regression is npm run test:browser using the prepared driver; see docs/verification.md for evidence and limits.

## Native read-only application

The native shell exposes only read/watch/unwatch/connection diagnostics. It uses the Run Unix API, structured Worktree/Tasks MCP clients, explicit Pool/Bridge observer helpers and read-only IDE diagnostics. Each source keeps its own freshness, pagination and failure semantics; a failed live source never becomes demonstration data. See docs/native-read-contract.md for exact routes, connection configuration and lifecycle bounds.

Use the pinned Rust1.98.1 and project-specific target/build/TMP directories documented in the family storage register. `node node_modules/@tauri-apps/cli/tauri.js build --debug --bundles app --no-sign --ci -- --offline --locked` produces a local uninstalled app with the default feature set and no test driver. An unsigned debug build is a development artifact, not a published/notarized release.

Native acceptance requires the separate native-e2e debug feature and tauri.native-e2e.conf.json. Run scripts/native-ipc-check.mjs for reviewed current-source reads, or scripts/native-ui-check.mjs for isolated six-source fixtures. Both require an explicit prepared app executable; UI acceptance also requires the root clearance marker. Tests never install/restart resident services. Building Hub does not activate the uncommitted producer API candidates or provision observer grants.
