# Native read seam v1

Owner-approved scope: one local macOS user, six family services, read-only observation. Renderer locale is ru/en; source task/message/report prose is preserved. The accepted UI uses full content-area detail screens and Back.

## Tauri interface

Expose only hub_read(request), hub_watch(request, channel), hub_unwatch(subscription_id), and hub_connections(). A request has a closed resource enum and params JSON object. Params are bounded to64KiB; source services retain their authoritative argument/domain validation. Never forward an arbitrary caller-supplied method, executable, command line, token, native actor or caller context. Each resource below maps to exactly one allowlisted read method.

A ReadResponse is {schema_version:1, source, resource, observed_at_ms, outcome, data, error}. source is run|pool|worktree|bridge|tasks|ide. outcome is ok|partial|unavailable|incompatible|missing|invalid. data retains the source's structured payload; absent/error is null, not an empty success. error is null or {code,message}, bounded and credential-redacted. Source timestamps, coverage, revision and pagination stay inside data and are not replaced by receipt time. An unknown build/version stays null.

The renderer normalizes source payloads with runtime shape checks into UI models. Malformed/unsupported replies become explicit errors, never fabricated progress. The Rust boundary validates envelope/correlation/byte budgets and transport identity. Locale changes never trigger source mutations or translate source prose.

| Resource | Public transport and fixed read |
|---|---|
| run.identity | Unix JSON-RPC ping + tools and advertised capabilities (finite discovery); unknown runtime build stays null |
| run.agents | list_agents |
| run.status | versioned status for one Pool-bound execution; selector, optional store fence and returned evidence are checked independently. Older brokers fall back to bounded inventory only when the method is unavailable. |
| run.transcript | transcript |
| run.transcript_exact | `transcript_exact` v1 with a fixed store, execution reference and active history pin; used only when advertised by Run |
| run.initial_task | `initial_task` v1 (read-only; capability `initial_task` from `capabilities` with `include_initial_task`, requested only when `tools` advertises the method): closed request shape `{version:1, mode strict/current, expected_store_id?, agent_id, sequence?, execution_ref?, pin_id?, offset?, max_bytes?, expected_sha256?, expected_total_bytes?}`; explicit nulls and unknown fields are refused before the source is contacted |
| run.answer | answer metadata or verified inline result |
| run.answer_chunk | proof-bound answer_chunk only when advertised; execution and digest are mandatory |
| run.models | models (existing callable compatibility read) |
| run.limits | limits |
| run.pools | list_pools (legacy namespace) |
| run.pool | pool (legacy namespace) |
| worktree.identity | stdio MCP get_status |
| worktree.list | stdio MCP list_worktrees |
| worktree.inspect | stdio MCP inspect_worktree |
| tasks.identity | stdio MCP get_status |
| tasks.peek | stdio MCP peek |
| pool.identity/list/get | observer-only API through agent-pool observe JSON stdin; never native MCP/assertions |
| pool.run_proof | observer `get` for one exact member and roster revision; accepts only the `run_proof` envelope |
| pool.inventory_snapshot | observer `inventory_snapshot` (owner-only; capability `inventory_snapshot_v1`): `filter` all/closed/not_closed, `limit` 1–10 and the producer's own `cursor`; accepts only the `inventory_snapshot` envelope |
| bridge.identity/overview/deliveries/incidents | diagnostics-only API through bridge observe JSON stdin; never admin/recovery |
| ide.identity | agent-ide doctor --read-only, structured installation JSON requiring read_only:true |
| ide.observe | agent-ide observe --repo ABS_PATH --json |

IDE installation diagnostics retain validated `read_only:true` findings on both
exit 0 (no error findings) and the producer's documented exit 2 (error findings).
Other exits, signals, incomplete requests and malformed reports remain unavailable.
Repository observations preserve `runtime:"unavailable"` when daemon diagnostics
time out; this is unknown runtime evidence, never a missing-runtime assertion.

Pool/Bridge observer contracts are implemented in separate uncommitted producer candidates. They are not installed or activated by building Hub. A missing installed method/configuration means incompatible/not_configured. Do not simulate data or read service databases. Worktree/Tasks adapters require structuredContent; never parse prose as a replacement. New source schemas are documented in the service worktrees; this envelope does not flatten away their error/partial states.

When Pool advertises `inventory_snapshot_v1`, the terminal reads the first one-row page of `inventory_snapshot` for exact source-wide retained totals bound to the source `{store_id, read_epoch, revision}`. Counts are canonical decimal strings. `open` and `completed` are null until the producer has a completion ledger and are displayed as unavailable; `closed` is an independent flag and never becomes Open or Completed. The loaded pool rows remain a separate `list` read and keep their loaded-only labels. The paged walk in `terminal/src/pool-inventory.ts` checks the one-snapshot fence, continuation cursor, row order and row count, restarts at the first page when any page fails or changes, and reports a bounded walk as partial; a producer `stale` error is reported with its own code. Without the capability no such read is sent. Written against the producer's uncommitted documentation of 2026-11-09 and synthetic fixtures; it has not been exercised against a running Pool.

When Run advertises `capabilities.initial_task` (version 1, modes `strict`/`current`, 524288-byte task and 65536-byte page limits), the terminal reads the selected execution's exact initial task once per execution identity (`r` rereads) with `terminal/src/initial-task.ts`. It uses `strict` only when the Pool binding proved store, first-attempt execution reference, an active pin and complete coverage for sequence 1; otherwise `current`, which proves only the currently retained root (optionally fenced by a known reference) and no pin, coverage or older Pool-binding claim. Every page is checked against the first page's store, agent, reference (and pin), whole-text length and SHA-256, byte offsets and UTF-8 text; nothing is shown until the last page, the buffered length and the SHA-256 all match, and the verified text appears under Details with its proof scope. Any `unavailable` reason (including `content_changed`), reason not in the closed set or not valid for the mode, typed error (a wrong store fence surfaces as `run_source_error`), malformed or oversized page, NUL/blank text or session change discards the buffer and keeps the label `Initial task unverified · showing retained history` with a static reason. Without the capability no `initial_task` request is sent and the label is unchanged. A Run that rejects the optional capabilities flag still answers the plain identity read. Written against the producer's `docs/api.md` section "Exact initial task (v1)" of 2026-11-09 and synthetic fixtures; not exercised against a running Run.

A producer error with code `stale` is reported as the fixed error code `stale` (outcome unavailable) instead of the generic `source_error`; no producer prose is reflected. Hub's inventory walk restarts at the first page and reports `source_stale`.

When Pool advertises `run_proof_v1`, the terminal observes the selected member through its revision-fenced Pool binding. Pool and Run observation times remain separate; unknown, stale or mismatched evidence is never promoted to cleanup or success. A broker's separate `run.status` view is still required to open a session and does not prove transcript or answer attribution. Older Pool observers use the direct Run status path only when identity explicitly confirms that the Pool capability is absent.

Pool chat v1 fields are optional so older Pool builds keep working. The terminal reads `kind` (`chat` or `managed`) and `completion_id` (string, or null when no record exists) from inventory `pools[]` rows and `get` details (the row or detail object, or its nested `pool`; two sources that disagree are rejected). Seat rows in inventory `pools[].roster[]` and `get` `view.members[]` of a chat pool may carry `seat_id`, `run_agent_id` (null until admission is recorded), `profile`, `admission` (`pending`, `admitted`, `refused`, `unknown`) and `joined`; the five fields are all-or-nothing, and a managed pool with seats is rejected. `completion_get` with section `header` on a chat pool answers under the `completion_page` kind with the agreement object `{version:1, completion_id, pool_id, revision, event_id, proposal_id, roster_key, result, ballots:[{seat_id, agent_id, vote_event_id}]}` and no `record_digest`; other sections are not requested. The terminal tells the formats apart by the missing `record_digest`, binds the agreement to the requested pool and completion ID, and shows the result as recorded by Pool, not digest-verified. Written against Pool `feat/pool-chat-v1` (`c68385c`) and the owner's stated observer addition, with synthetic fixtures (`terminal/test/fixtures/pool-chat-v1.json`); not exercised against a running Pool.

An exact transcript copy requires freshly verified Run status and the advertised fenced read. Each page is correlated to the same store, selector and history watermark; complete UTF-8 messages are assembled and hash-checked before any clipboard submission. Missing or incomplete content, released pins and source failures abort the whole copy. This historical snapshot does not establish author identity or current completion.

## Configuration

Read app-owned connections.json from the Tauri app configuration directory, with an explicit AGENT_HUB_CONFIG path override for reproducible local testing. Missing file uses documented installed defaults; a malformed explicit configuration is an error, never silently another installation. Configuration contains absolute program/socket/config paths and optional known repository paths, no arbitrary renderer-controlled commands. Default installed CLI paths come from the user's .local/bin; Run defaults to .agent-run/api.sock. Per-service overrides allow a reviewed candidate executable without replacing installed services. Diagnostics expose connection state and safe paths/version, never credential contents.

An explicitly shared Run socket requires both an absolute `run.socket` and the trusted `run.broker_uid`, matching the broker's actual Unix UID. This opt-in allows group access to the socket; the broker must own its socket and parent, the parent must not be group/world writable, the socket must not be world accessible, and the connected peer UID must match before any request. Without `broker_uid`, the existing same-user private-socket checks apply. The renderer cannot choose either setting.

The app does not edit tool configuration, install/start/restart residents or enable grants. Pool/Bridge observer helpers own their dedicated read-only credentials. Native renderer calls cannot request writes even if an underlying service has a wider surface.

## Transport/lifecycle

Use Tokio for bounded Unix reads and owned child processes; prepared rmcp3.4 for stdio MCP. Run uses the private same-user endpoint by default or an explicitly configured shared broker UID as described above; it checks peer UID through Tokio/rustix, validates JSON-RPC ids and limits complete frames to1MiB. One finite call per connection avoids cancelled-frame reuse and read head-of-line blocking. No general HTTP listener. CLI calls use program+argv arrays and bounded stdin/stdout/stderr, never a shell command. Do not forward raw stderr or credentials to React.

Owned MCP frontends may persist while the app is open; they never own resident-service lifetime. Kill/reap only app-created frontend/read subprocesses on cancellation/shutdown, never service daemons or agent groups. All helper temp paths must be explicit under <tmp-root>/<tool>/hub-runtime, where <tmp-root> is the parent of the app temporary directory and <tool> its sibling per-tool directory.

Watchers send ordered ReadResponse values through Tauri Channels. Bound active subscriptions and concurrent reads; dropped views cancel their subscriptions and ignore obsolete generations. Use Run's revision+message_revision long-poll, keeping transcript/detail calls independent. Other defaults: Pool/Bridge5s, selected Pool history2s, visible Worktree/IDE15s, cached quota60s. Skip missed ticks, never overlap a slow poll, use bounded backoff. Closing the last window stops all subscriptions; the app has no background observer. No source error becomes an agent cancellation.

## UI integration rules

Native production mode uses real reads only. Demo is an explicit build/runtime selection for browser previews and tests, never an automatic fallback when live data is unavailable. Loading/error/stale/partial/empty are distinct. Preserve last good data with its original observed time on temporary disconnect.

Use all pagination cursors, deduplicate by source+stable id, fence sequence changes and navigation generation. A first page is not a total: show source coverage and explicit load-more when data is bounded. Link Run workdir to the longest confirmed Worktree path; repository grouping uses the canonical common directory. Unknown links remain unknown. Legacy Run pools and standalone Pool are separate namespaces.

Tasks reads only peek. No status, plan-save, inference, settle, delivery reconciliation or refresh-generated reports. Worktree inspection/size is on demand; background inventory stays cheap. All protocol reads remain separate from future management commands.

## Required tests

Use isolated fake Unix/MCP/CLI services to prove the exact read allowlist, denied mutation attempts, framing/correlation/malformed/oversized replies, disconnected/incompatible sources, all-page pagination (>200 agents), cancellation and child cleanup, no daemon start or model calls, and no credentials in renderer responses. Native current-source smoke must call only existing read routes and must not claim unavailable observer APIs are live. Production bundle must exclude any test driver.

## Observer CLI framing

The new Pool/Bridge observe frontends accept exactly one bounded UTF-8 JSON line on stdin: {schema_version:1, operation, params}. Pool operations are identity, list, get; Bridge operations are identity, overview, deliveries, incidents. The executable/argv are fixed by the native adapter: agent-pool observe or bridge observe, with optional --config ABS_PATH from app-owned configuration. No token or native identity is supplied by the renderer. Each helper loads only its explicitly configured observer credential and calls its product's read-only API. The helper prints one bounded versioned typed JSON response on stdout and uses ordinary exit codes; it never writes raw secrets to stderr. Existing commands remain unchanged.

Worktree MCP outer kinds: identity/worktree_page/worktree_detail. Tasks kinds: product_identity/project_snapshot. Tasks peek data contains repository{id,common_dir,source_path}, plan_state,plan,report_state,report,pending,error. Saved report retains its original plan revision and observed_at/completed_at. Treat data.error as a structured failure, not missing data.

## IDE read-only identity

The existing no-argument doctor command is not suitable for Hub: it may retire abandoned runtime directories and create locks. Hub calls only doctor --read-only, the additive producer mode that returns the installation report plus read_only:true and never locks/prunes runtime state. An older installation without this mode is incompatible; there is no fallback to the mutating doctor. Installation findings do not establish per-repository daemon or check health. Repository observation remains observe --repo ABS_PATH --json.

## Producer page arguments

Worktree list arguments are repo?, discovery?, cursor?, limit? (maximum20); the page-wide size flag is denied because its shared page budget would degrade every row's merge and activity probes. Inspect accepts repo and exactly path or name, plus explicit boolean checks (status, integration, processes, submodules, size); size is one bounded, read-only walk of a single worktree that the terminal requests lazily and caches; key is a response identity, never an inspect argument. Hub connections returns {schema_version:1,state:configured,run:{socket,version:null},programs,repositories}; invalid configuration instead carries state:invalid and error.

Standalone Pool list accepts after?:string. Get accepts pool_id, section? (overview/members/history/proposal/votes/deliveries/binding/decisions), after?:u64, proposal_id?, member_id?, include_bindings?:bool. Success kinds identity/pool_page/pool_detail. Pages contain pools:[{pool,leader_id}], cursor,has_more,returned,observed_at_unix_ms,source_timestamp:null,coverage. Detail carries section,view,leader_id,optional explicit bindings,decisions and page metadata. No historical source time is fabricated when Storev1 lacks it.

An observed `replace` delivery is a request concerning its original `member_id`. Only `accepted` reports that Pool recorded the replacement after a Run receipt; `refused` reports that this request did not replace the member. `cancelled` reports cancellation before Run admission was sent. Queued, inflight, unknown and unrecognized states do not confirm a replacement. This requires a compatible Pool observer; a Hub build does not establish that one is installed.

Bridge observe kinds identity/bridge_overview/delivery_page/incident_page. Page parameters limit1..200,after_seq?0,through_seq?; incidents additionally include_closed?false. Page data contains deliveries or incidents,through_seq,next_after_seq,coverage:retained_history. Observer helper configuration is explicit and never substitutes an operator/admin grant. Delivery metadata excludes message content and native-session/credential data.

## Retained Tasks clocks and estimates

Tasks peek reports the stored current plan separately from report.plan; their revisions may differ. The report carries analysis.outcomes with original state, nullable progress_percent, summary, remaining, integrated and cited evidence lists, plus findings and coverage. No aggregate progress is provided by peek. Render saved row estimates without inventing a new total. observed_at is RFC3339 UTC or an explicit unknown legacy label; completed_at is a decimal Unix-seconds string or unknown. Preserve original clocks and units; receipt time never replaces them. Pending accepted means a stored admission receipt, not verified current execution. data.error makes the observation unsuccessful; other fields have no success guarantee on that branch.

## Native acceptance isolation

Native WebDriver is an explicit debug-only feature; nondebug native-e2e builds are compile-time refused. The normal feature set has no test driver. The separate acceptance config uses its own application identifier and nonpersistent WebView, and grants own-app show plus show/set-focus for its own main window in addition to the same read surface. The normal main capability remains allow-hub-observation only. Tests require real visible/focused WKWebView state; they never replace document visibility APIs. Invoke the packaged acceptance app executable, not an identity-less copied executable. Keep hash-named test app bundles separate from the normal app so builds cannot replace an executing acceptance target.
