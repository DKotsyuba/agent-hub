# Agent Hub server and web UI

## Decision

Ship one Bun/TypeScript Hub server with a read-only API and two clients. Keep
OpenTUI in `terminal/` and reuse the parked React, shadcn/ui, Tailwind and Vite
app at the repository root. Establish parity with the v0.1.3 TUI on Dobi,
including Overview, Sessions, Pools and chat, Quota, Worktree and the Overview
link to Bridge incidents. Retain producer capability gates and partial coverage
labels. Tauri stays parked. Fixture mode requires an explicit test or dev
selection in either client. Release builds always use the live HTTP API.

## Processes and permissions

```text
Owner phone/browser or remote TUI
  -> tailnet HTTPS hub.<tailnet>.ts.net:443 (dedicated Tailscale Serve node)
  -> private Unix HTTP socket
  -> hub-server (Bun) <- same Unix HTTP socket <- TUI on Dobi
       -> finite Rust observer -> Run, Pool and Quota Unix sockets
                              -> Worktree MCP over stdio
                              -> configured Bridge observer over stdio
```

Run the server as `pluto` (UID 1000) with supplementary group `agent-run`
(GID 986), matching the owner TUI. Keep the connection schema and the checked-in
[Dobi template](../../packaging/etc/agent-hub/connections.json) for expected
Run (UID 1003), Pool (UID 1003) and Quota (UID 999) peers. Check the effective
group, Quota service allowlist, peer UIDs and socket permissions during
activation. Worktree currently invokes the configured `agent-worktree mcp`
program for its closed set of reads. Bridge needs its existing diagnostics-only
observer configuration where available. The Pool group socket deliberately
omits private bindings and Run proofs. Carry capability/availability through to
both clients and retain the existing authority checks before every source read.

Use a system service, enabled at boot without an interactive login. Install
versioned, administrator-owned files under `/opt/agent-hub/`; point `current`
at the reviewed release. Set the owner-controlled source config explicitly:

```ini
[Unit]
Description=Agent Hub read-only server
After=local-fs.target

[Service]
Type=simple
User=pluto
Group=pluto
SupplementaryGroups=agent-run
UMask=0077
RuntimeDirectory=agent-hub-http agent-hub-tmp
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
Environment=AGENT_HUB_CONFIG=/etc/agent-hub/connections.json
Environment=TMPDIR=/run/agent-hub-tmp TMP=/run/agent-hub-tmp TEMP=/run/agent-hub-tmp
ExecStart=/opt/agent-hub/current/bin/hub-server --unix /run/agent-hub-http/http.sock
NoNewPrivileges=yes
KillMode=mixed
TimeoutStopSec=35s
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=multi-user.target
```

Use `Bun.serve({ unix })` with a filesystem socket owned by `pluto:pluto`, mode
`0660`, inside the mode-`0750` directory. The server is local-only on Dobi
with zero TCP listeners. The gateway binds HTTPS on the tailnet. Allow an
explicit `127.0.0.1` bind for isolated development only. The Unix socket keeps
other Dobi accounts from reaching the owner's combined reads through localhost.
Keep the HTTP socket directory across service restarts so the gateway's
directory mount can see the new socket inode. At startup replace a stale
socket only inside that owned directory, and refuse unexpected file types.
Order the gateway's boot unit after Docker and Hub, and start its Compose
service after the local socket answers health. Stop/drain the gateway before
removing the backend.
[Bun HTTP server socket options](https://bun.com/docs/runtime/http/server).

Move the process adapter from
[`terminal/src/client.ts`](../../terminal/src/client.ts) to the server. Keep
the [observer](../../terminal/observer/src/main.rs) one-shot protocol. Each
child receives one newline-terminated `{resource, params}` JSON frame. Keep
stdin open until the result arrives. EOF cancels the read. Expect one
newline-terminated `ReadResponse` with the matching resource and validate
its payload before caching. Retain the native frame and deadline limits,
minimal child environment, and cooperative cancellation followed by a five
second kill deadline. Wait for children on shutdown, then let systemd reap
stuck descendants through the service cgroup. Source daemons have independent
lifecycles. Add coalescing for identical in-flight reads, bounded admission
per source and per-client stream limits. Cancel an in-flight read when its
last consumer leaves. Keep the existing 10-minute Worktree facts cache and
one bounded status/size inspect at a time. Keep expensive reads out of the
live poll. Source outages leave the server running and surface independently.

## Workspace and client migration

| Path | Ownership and extraction |
| --- | --- |
| `packages/domain/` | Shared API DTOs, runtime validators, IDs, cursor and error types. Split portable parsers and producer contracts from `src/live/protocol.ts` and `terminal/src/api.ts`. Keep producer wire versions separate from the HTTP version. |
| `packages/view-model/` | Pure session identity, transcript grouping/verification, Pool inventory/seat/journal/completion logic, Quota windows and Worktree grouping/session matching from `sessions.ts`, `transcript.ts`, `run-status.ts`, `pool*.ts`, `completion.ts`, `quota*.ts` and `worktree*.ts`. Extract renderer-independent filters, clocks, status tones and coverage math where `hub.ts` mixes them with rendering. Pass locale, time zone and current time explicitly. Keep proof verification in the server's observation path and reuse pure verification code where needed. |
| `packages/client/` | Shared typed HTTP client, validation, abort/latest-request handling, pagination and fetch-based SSE reader. Inject the fetch transport so both browser and Bun use it. Supply deterministic fixtures at this seam. |
| `server/` | Bun HTTP routes, observation projection, coalescing, Worktree ID resolution, SSE scheduling and static assets. Move the canonical observer to `server/observer/` with its Cargo lockfile and shared Rust adapter source paths updated. |
| `terminal/` | OpenTUI drawing, cell wrapping, key/mouse handling, focus and scroll anchors stay in `hub.ts`. Keep CLI and clipboard output adapters, and the file-backed theme in `preferences.ts`. `standalone.mjs` extracts only OpenTUI assets. |
| Root `src/` | Keep Vite, `components.json`, unmodified shadcn components, CSS tokens, and EN/RU catalogs. Reuse the shell, detail/focus patterns, and compatible views. Replace the web entry's Tauri `invoke`/Channel dependency in `src/live/native.ts` with the shared client and adapt `src/live/hooks.ts` to the HTTP/SSE lifecycle. |

Use one private root manifest with `workspaces: ["server", "terminal",
"packages/*"]`. The root package is the web app. Bun runs workspace scripts
with `bun run --filter <workspace> <script>` and compiles server and TUI.
Keep npm as the installer under the repository policy. Consolidate workspace
inputs into one root `package-lock.json` using npm-compatible local package
references and `npm ci --ignore-scripts`. Root owns the lock migration and
build orchestration. [Bun workspace script support](https://bun.com/docs/pm/filter).

Keep `agent-hub --live` as the default. Use `/run/agent-hub-http/http.sock` on Dobi by
default, or the explicit `--server https://hub.<tailnet>.ts.net` endpoint.
The local transport uses Bun fetch's `unix` option. Reuse a small
`ObservationClient` adapter during the TUI swap, then replace its polling
with the same HTTP/SSE client used by the web. Preserve `--pool ID`, project
startup selection (match the server-reported project by path or stable ID),
`--demo`, Back behavior and clipboard operations. Move Run source selection
(`--home`, `--socket`, `--broker-uid`, `AGENT_RUN_HOME`) to administrator
configuration and document the CLI migration. There is one live transport and
no direct producer fallback. Report Hub disconnection and retry that Hub.
[Bun fetch over Unix sockets](https://bun.com/guides/http/fetch-unix).

## HTTP API

All routes below are GET under `/api/v1`. Pin incompatible changes to a new
API major and accept additive optional fields within v1. A data response is
`{ data, page?, observations, capabilities? }`. Each observation reports its
source, outcome, producer timestamp when available, and Hub observation time,
with optional coverage and a safe issue. Use 200 for useful data with partial
or independently unavailable sources. An empty healthy collection differs
from an unavailable source. Clients may retain the last good response for the
same query and mark it stale with its original timestamp.

| Path | Parameters and response |
| --- | --- |
| `/health` | Process/API readiness and release version. Source outages appear on their resource endpoints. |
| `/overview` | `from`, `to` epoch milliseconds calculated in the client's time zone, for Run and Bridge period metrics, current Run work, and Quota highlights. Each source carries its own coverage. |
| `/sessions` | `status`, `project`, `q`, `from`, `to`, `limit`, `cursor`. Active and retained execution inventory. |
| `/sessions/:id` | Execution details and producer capabilities. An optional `execution` selector fences links from Pool or historical lineage. |
| `/sessions/:id/history` | `execution`, `edge=start\|tail`, `direction=older\|newer`, `cursor`, `limit`. Grouped transcript and tool pairs. Report retained/verified coverage and legacy raw pagination when the producer explicitly lacks grouped reads. |
| `/sessions/:id/initial-task`, `/sessions/:id/result` | One execution-bound verified read via bounded pages. Initial task preserves strict/current/unverified provenance. Result remains unavailable if execution or digest checks fail. |
| `/sessions/:id/export` | `execution`, `mode=retained\|exact`, `cursor`. Copy/export through a fixed source boundary. Exact reads retain the store, execution reference and pin checks. Retained reads report incomplete coverage. |
| `/pools` | `state=open\|closed\|all`, `q`, `limit`, `cursor`. Inventory, kind and available source totals. Closure alone supplies neither completion nor an exact count. |
| `/pools/:id` | Metadata, kind, capabilities and available completion/agreement record reference. |
| `/pools/:id/sections/:section` | Closed set `members`, `proposals`, `decisions`, `criteria`, `votes`, `deliveries`. `cursor`, `limit`, optional `proposal` for relevant sections. Member/seat links carry available Run identity evidence. |
| `/pools/:id/history` | `edge=start\|tail`, `direction=older\|newer`, `cursor`, `limit`. Discussion/chat window with export upper bound and completeness. Older observers use forward-only history. |
| `/pools/:id/content/:field` | `field=purpose\|snapshot`, optional `proposal`, `cursor`. Revision-fenced text pages. |
| `/pools/:id/records/:record` | `cursor`. Frozen completion or chat agreement record. Preserve the distinction between digest-verified completion and Pool-recorded agreement. |
| `/quota` | Source status and schema-validated account/window snapshot, reset, evidence, advice and details. Unknown numbers remain unknown. |
| `/worktrees` | `project`, `limit`, `cursor`. Discovered project/worktree rows with cached fact state, activity and related sessions. |
| `/worktrees/:id` | Listed row, bounded inspect and related sessions. Resolve stable IDs through known project inventory; API requests cannot select a repo/path for inspection. |
| `/bridge/incidents` | `from`, `to`, `includeClosed`, `limit`, `cursor`. Overview drill-down with independent diagnostics availability. |
| `/events` | One SSE connection per foreground client. Repeated `topic` selects scoped updates, as below. |

List and history pagination returns `page: { next, previous, resume }` with
nullable opaque strings. Bind each cursor to resource, normalized filter/order,
direction and any producer revision, execution, digest or watermark needed
by that read. Validate the decoded cursor against the route and bounded
field schema before any observer call. Start with a default page size of 50
and a max of 200, clamped to stricter source limits (Worktree is 20). Bound aggregates and scans, and
report incomplete coverage if a producer or Hub budget stops the scan. Keep an
offset-backed source's limitations visible. Pin its revision when available
and deduplicate by stable ID, without claiming snapshot consistency where the
producer cannot supply it. Stable ordering uses the producer position or a
deterministic sort key with ID as a tie breaker. History cursors preserve
older-page anchors separately from the newer/live resume position. Verify
chunked content against its execution/digest, record digest, or revision before
showing or copying it. Enforce an assembly byte budget and fail explicitly when
a proof or the budget is exhausted.

Errors use `{ error: { code, message, retryable, requestId } }`. Use 400 for
invalid filters, IDs or cursors, 404 for a missing supported resource, 405 for
methods outside the read API, 409 for expired/stale revision or execution
fences, 422 for an unsupported producer capability, 429 for saturation, 502
for an invalid producer projection, and 503 for a temporarily unavailable
source. A 409 instructs the client to reload the relevant boundary. Use safe
machine codes, localize client messages, and keep source stderr, connection
settings, local path inputs and secrets off the API. Only explicit routes can
reach the native allowlist. Serve same-origin with no cross-origin API access,
validate Host against the configured public hostname or the local Unix
transport's `localhost`, and accept a browser Origin only when it matches
the public origin. Use
`Cache-Control: no-store` for observations. Render source text as text and
keep source-supplied links out of executable URL schemes.

**Live channel.** SSE carries `ready`, `changed` and `source-state` events,
plus a 15-second heartbeat comment. For example, subscribe to
`/api/v1/events?topic=pools&topic=pool:pool-123:history`. The closed topic
set mirrors Overview, Sessions, Pools, Quota, Worktree and Incidents and
allows one selected detail scope per stream. Use a shared 3-second default
poll on subscribed topics, with a validated `interval=1|3|5|10` seconds query
parameter. Coalesce at the fastest requested cadence per topic and back off
during producer failure. Send small invalidations with topic and the latest
source boundary when known. Clients coalesce refreshes and pull changed
pages over GET. Bound stream queues
and close slow consumers for reconnect. Treat SSE as a wake-up signal.
Subscribe before the initial page read, revalidate on `ready` and reconnect
with bounded backoff. After a gap, continue GETs from the last *applied*
producer cursor until caught up. An invalid or retained-away cursor reloads
the current edge and marks any missing coverage. This recovers across process
restarts without a durable event log or reliance on SSE event IDs. Opening a
stream alone must never launch an unbounded historical scan.

Reserve explicit command routes for a later approved phase, e.g.
`POST /api/v1/pools/:id/replies` and
`POST /api/v1/sessions/:id/cancel`. Keep command dependencies separate from
the observer. Reassess producer-side writer grants and the browser trust
boundary then. Plan for idempotency keys, execution/revision preconditions,
same-origin request protection, and status reconciliation for ambiguous
outcomes. V1 ships the GET surface and read-only UI.

## Web screens and interaction

| Route | Screen |
| --- | --- |
| `/`, `/incidents` | Overview cards with period selector, source coverage, Quota highlights and attention links. Bridge incidents are a drill-down. |
| `/sessions`, `/sessions/:id/:tab?` | Active/finished list with search and filters. History, Result and Details, including initial task proof, transcript tools, copy/export and follow controls. |
| `/pools`, `/pools/:id/:tab?` | Open list with collapsed Closed group. Member/seat, Discussion/chat, decisions, criteria, votes and deliveries views. Show completion or agreement from the applicable record, and link related sessions with available evidence. |
| `/quota` | Per-account windows, status, reset, burn/reserve and source warnings, with technical evidence expandable. |
| `/worktrees`, `/worktrees/:id` | Project cards, merge/activity/size/change facts and linked sessions. Load expensive facts for viewed rows within the server budget. |

Use the same URL for a selected record at any width. At `1024px` and wider,
use a split list/detail layout for Sessions, Pools and Worktree. Below that,
open the full-screen detail and use a visible Back link; restore the originating
list filters, scroll and focused item. A standalone deep link returns to the
parent list. Keep selected tab and shareable filters in the URL, preserve
focus on background refresh, and move it to the detail heading on mobile
navigation. Overview and Quota reflow from columns to one column. Use existing
shadcn Tabs, Table, Badge, Progress, Input, Select, Button and Separator with
native links for navigation. Use Dialog for auxiliary shortcuts/help. Keep
the neutral CSS tokens and system/light/dark setting, stored alongside language
in browser-local preferences. Use the EN/RU catalogs for chrome and statuses,
preserving producer messages in their original language.

History initially opens at the retained start for Sessions and the tail for
capable Pool discussions. While following, append and scroll only if the
viewport is at the tail. Browsing older content preserves the visible anchor
and shows an unread count with a Jump to latest control. On mobile background
or page hide, close SSE and abort obsolete reads. On return, reconnect,
revalidate and catch up from the saved position without moving a paused
viewport. The same behavior covers browser suspension and tailnet roaming.

## Dobi access

Use a **dedicated userspace Tailscale node with ordinary Serve**, following
the Dobi OpenCode sidecar pattern. The host currently reports Tailscale
1.104.5, MagicDNS and HTTPS enabled, and an untagged main node. Hosting
`svc:hub` on that node would require a tagged identity and host approval.
Ordinary Serve on the main node uses its existing hostname. A separate
`tsnet` proxy could give `hub` its own name but adds a Go binary and release
work. The existing Dobi sidecar pattern gives the separate name, TLS
renewal and a private Unix backend using the stock Tailscale image.
[Tailscale Services](https://tailscale.com/docs/features/tailscale-services),
[Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
[tsnet TLS](https://tailscale.com/docs/reference/tsnet-server-api).

After owner approval, define `tag:hub` for the dedicated node and grant the
owner's tailnet login access to `tag:hub` on TCP 443 only. Check effective
policy for overlapping broad grants, and test accept and deny cases before
publishing. Use the existing Dobi sidecar shape with the reviewed digest-pinned
Tailscale image, a dedicated bridge network, no published ports, all Linux
capabilities dropped, root in the container for Unix-socket Serve configuration,
and supplementary GID 1000 to traverse/connect to the host socket. Mount
`/run/agent-hub-http` read-only at `/gateway` with automatic source creation
disabled. Use `dobi_hub_tailscale_state:/var/lib/tailscale` for the node's
persistent state and a private mount for its control socket. Start with
`tailscaled --tun=userspace-networking --port=0 --statedir=/var/lib/tailscale
--socket=/var/run/tailscale/tailscaled.sock`. Use a separate Compose service
`tailscale-hub` in the approved Dobi deployment configuration.

```sh
docker compose up -d tailscale-hub
docker compose exec tailscale-hub tailscale up --hostname=hub --advertise-tags=tag:hub --accept-dns=false --accept-routes=false --ssh=false --timeout=30s
docker compose exec tailscale-hub tailscale status
# Complete login/approval, verify the FQDN, then apply the Hub origin drop-in.
docker compose exec tailscale-hub tailscale serve --bg --https=443 unix:/gateway/http.sock
docker compose exec tailscale-hub tailscale serve status
docker compose exec tailscale-hub tailscale funnel status
```

Verify the actual MagicDNS name and set `AGENT_HUB_PUBLIC_ORIGIN` in a
systemd drop-in before enabling Serve. Expect `https://hub.<tailnet>.ts.net/`.
Tailscale terminates TLS, provisions and renews the certificate. The certificate name is visible in
Certificate Transparency. Funnel stays disabled. Tailnet policy and local
socket permissions enforce owner access, with no application login. Verify the
local socket as the owner and as an unrelated UID. Verify allowed HTTPS and
confirm other local services are unreachable through the dedicated node.
For rollback of exposure, run `docker compose exec tailscale-hub tailscale
serve --bg --https=443 off` and verify the route is gone. Keep the node state
for restoration. Dobi's primary node keeps its existing identity and routes.
[Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates).

After activation record the observed FQDN, owner `pluto` and operator,
purpose, date and verification source, HTTPS 443 and `/` to
`unix:/gateway/http.sock` on the dedicated network, the host socket mapping,
owner-only grant, no app auth, Serve and Funnel status, unit and Compose
paths, persistent state volume, and any pending checks in
`Dobi/docs/tailscale/registry.md`. Record route changes/removal with dates and
evidence, including restart and owner-device results when available.

## Release

One deployable asset per release, `agent-hub-X.Y.Z-linux-x86_64.tar.gz`.
Include compiled Bun `bin/hub-server` and `bin/agent-hub`, the locked Rust
`libexec/agent-hub-observer`, built Vite `share/web/`, a unit and connection
template, `LICENSE` and expanded `THIRD_PARTY_NOTICES.md`. Resolve bundled
assets relative to the release directory. Serve only the web build and its
known SPA routes, with immutable hashed assets and a revalidated entry page.
Keep the Linux x86-64/glibc baseline and include the OpenTUI native library
through the current private runtime extraction mechanism. Deployment needs
no Bun, npm or Rust installation. Version upgrade and rollback select a whole
release directory and restart the unit. Keep operator configuration external.

Update [RELEASING.md](../../RELEASING.md) and
[`ci.yml`](../../.github/workflows/ci.yml) /
[`release.yml`](../../.github/workflows/release.yml). Keep pinned runtimes,
locked builds, native observer fmt/clippy/tests and Bun/Node compatibility
coverage for applicable code. Add shared contract tests, HTTP/stream/shutdown
fixture integration, Vite typecheck/build and browser parity checks. Expand
notice generation to the workspace lock and web assets, and retain license
material for OpenTUI. Test the extracted archive in an isolated runtime with
fixture producers, exercising its HTTP API, TUI, a web deep link and SSE.
Keep deterministic packaging, path redaction and tag/version checks across
the payload. Publish the archive plus `SHA256SUMS` and attest the archive. Preserve the
reviewed release environment and draft download/hash/attestation checks.
Replace the standalone bare executable download with the archive.

## Delivery and acceptance

The [v1 contract and fixture handoff](hub-v1-contract.md) and [TUI parity
checklist](hub-v1-parity.md) define the package A integration surface.

| Package | Ownership and dependency | Owner-checkable acceptance |
| --- | --- | --- |
| A. API and fixtures | Root owns manifests/lock/build configuration. Freeze endpoint DTOs, coverage, fixture scenarios and parity checklist. | Read v1 examples covering populated, empty, partial/stale, incompatible and unavailable data. Confirm all TUI views and evidentiary labels have an API mapping. |
| B. Backend | Server implementer owns `server/` and observer relocation after A. | Two local clients share source reads. Observer timeout, abort, restart and shutdown leave no children. Read-only requests work and blocked method/path or producer authority fails before dispatch. Pass cursor and reconnect fixture checks. |
| C. Terminal migration | TUI implementer owns `terminal/` and nominated pure view-model extracts after A. | Compare old/new Linux TUI on the same fixtures, covering key bindings, full-screen Back, opening/following history, exports, Pool chat/agreement, Quota and Worktree. Removing the HTTP connection produces a disconnected state; the TUI never spawns an observer. |
| D. Web parity | Web implementer owns root `src/` after A. Implement against shared fixtures while B and C proceed. | Use every primary screen and Bridge drill-down. Check both themes at 1440×900 and 1100×720 plus phone portrait, keyboard/focus restoration, overflow and data states. Check background/resume, long chat and EN/RU. Pass root `npm run typecheck` and `npm run build`. |
| E. Release and Dobi qualification | Root integrates B, C and D, packages and coordinates reviewed activation. | Verify one fresh archive end to end. On Dobi, demonstrate actual Run/Pool/Quota/Worktree reads and configured Bridge status, owner phone HTTPS and live follow after reconnect, denied access from a non-granted identity, unreachability outside the tailnet, and absence of a TCP backend or public Funnel. Confirm service restart and registry evidence. |

Critical path is **A → B → E**, with C and D required at the E convergence
gate. Three implementers can take B/C/D after the contract freeze; with two,
one takes B and the other sequences C and D against fixtures. Agree on the
observer path in A, and let the TUI owner update references in terminal tests
while B owns the observer files. The nominated extract owner edits the
shared view-model files and coordinates contract changes with Root. Findings from fixtures and browser screenshots
are separate from the approved live Dobi qualification.
