# Hub API v1 contract and fixture handoff

The wire contract is [@agent-hub/domain](../../packages/domain/src/index.ts).
`API_ROUTES` lists the 19 GET routes and `API_RESPONSES[route]` validates
each JSON success response. `ApiResponse<'sessionHistory'>` is one example of
its associated TypeScript type. `parseApiRequest` normalizes route parameters
and clamps page sizes. The server still owns authorization, cursor integrity,
bounded reads, source-version validation and proof verification. API version
1 is independent of every producer schema version.

## Wire conventions

- `/health` returns `ready`, `apiVersion`, `release` and `mode`. All other
  JSON successes return `{ data, observations, capabilities? }`, with an
  additional required `page` for paginated endpoints. Every observation has
  its source, outcome, `producerAtMs` (nullable) and `observedAtMs`.
  Coverage states apply to their declared scope. A complete retained page
  makes no claim about pruned history. `staleSinceMs` marks retained data
  without refreshing its observation clock.
- Clock and duration fields ending in `Ms` are epoch milliseconds or elapsed
  milliseconds, respectively. Periods use inclusive `from` and exclusive
  `to`. Session filters accept `active`, `finished`, `all` and individual Run
  lifecycle statuses. Session period filtering uses finish time for finished
  rows and creation time otherwise. Project filters use stable project IDs.
  Path-derived folder picks can filter already-loaded session rows by `workdir`.
- Resource IDs and execution selectors are URL-safe strings. Treat
  `execution`, boundaries and cursors as opaque. Preserve the normalized
  resource/filter/sort and any initiating edge when following a cursor.
  `page.next` advances the page, `page.previous` browses older rows, and
  `page.resume` is the live continuation for an **applied** page. Keep a
  saved live resume when browsing older pages. History with no explicit
  edge starts at the retained start for Sessions, at the tail for capable
  Pool observers, and at the start for legacy Pool observers.
- `textChunk.offsetBytes` and `totalBytes` describe the complete UTF-8
  payload. Follow `page.next`, check contiguous bytes, stable total and
  stable execution, digest, revision or record fence as applicable. Display
  or copy verified content only after the full assembly passes. The exact
  export digest covers the exact projected text. For completion, one record
  digest binds the record pages and each content field has its own SHA-256.
  For agreement, `kind: "agreement"` identifies Pool-recorded evidence.
  A failed answer proof has no text response.
- `observations` distinguish empty (known), partial (useful), stale
  (retained), incompatible and unavailable. `capabilities` are independently
  tri-state. Offer gated actions only for explicit support. Unknown totals
  and unmeasured probe values are nullable or have a typed state. Pool
  snapshot totals and event positions are decimal strings, preserving
  wide producer counters. In Pool rows a missing `record` means unreported.
  A present null means the source reported no retained record.
- The SSE frame name matches the JSON `type`. Each of `ready`, `changed`
  and `source-state` uses the validator `event`. A heartbeat is a comment
  every 15 seconds. Root topics are `overview`, `sessions`, `pools`,
  `quota`, `worktrees`, `incidents`. A stream can also carry topics for one
  selected resource, such as `pool:pool-chat-1:history` and
  `pool:pool-chat-1:members`. Subscribe before initial GET, revalidate on
  `ready` and reconnect, and catch up from the last applied cursor.
- Errors have `{ error: { code, message, retryable, requestId } }`.
  `ERROR_STATUS` defines the v1 machine codes. Handle `stale_boundary` (409)
  by reloading the affected boundary. Surface `unsupported_capability`
  (422) separately from `source_unavailable` (503). Preserve any last good
  data for the same query under its original timestamp when appropriate.

## Fixture transport

From the repository root with Bun 1.4.4:

```sh
bun --no-install packages/client/fixtures/serve.mjs populated 4180
curl 'http://127.0.0.1:4180/api/v1/pools/pool-chat-1/history?edge=tail&limit=2'
curl -N 'http://127.0.0.1:4180/api/v1/events?topic=pools&topic=pool:pool-chat-1:history'
```

`npm run fixtures -- populated 4180` starts the same loopback service.
Select a scenario explicitly. The service holds a fixed snapshot, sends
one synthetic changed event per topic per connection, and heartbeats.
It uses zero producers and exposes no CORS. Web can inject
`createFixtureFetch(scenario)` from `@agent-hub/client/fixtures` or use a
development-only same-origin proxy with the loopback Host. Terminal may
use the same injected fetch or explicitly point its development HTTP
client at loopback. The catalog includes a fixed `clockMs` for period tests.

| Scenario JSON | Example reads and expected evidence |
| --- | --- |
| [populated](../../packages/client/fixtures/populated.json) | `/sessions/demo-finished/history` has tool pairs and an orphan result. `/sessions/demo-finished/result?execution=exec-finished` has paged hash-checked text. `/sessions/demo-historical/initial-task?execution=exec-old` and `/sessions/demo-inspect/initial-task` exercise strict and current. `/pools/pool-chat-1/records/agr-7` is recorded agreement, while `/pools/pool-managed-1/records/completion-demo` is digest-bound. `/bridge/incidents?includeClosed=true` includes open and closed rows. |
| [empty](../../packages/client/fixtures/empty.json) | `/overview` reports observed zeroes and `/sessions`, `/pools`, `/quota`, `/worktrees` and `/bridge/incidents` return healthy empty data. |
| [partial-stale](../../packages/client/fixtures/partial-stale.json) | `/overview` retains stale Run, covers partial Quota and reports Bridge unavailable. `/sessions/demo-inspect/history` is legacy raw and its initial task is unverified. `/pools/pool-managed-1/history` is forward-only. `/worktrees/wt-review` distinguishes a lower-bound change count from unavailable size. |
| [incompatible](../../packages/client/fixtures/incompatible.json) | `/health` stays ready. Data endpoints return 422. `/events?topic=overview` has incompatible source states. |
| [unavailable](../../packages/client/fixtures/unavailable.json) | `/health` stays ready. Data endpoints return 503. `/events?topic=overview` has independently unavailable sources. |

Fixtures project the synthetic outputs from `terminal/src/demo.ts`,
`terminal/test/fixtures/` (Run status, Pool chat and snapshot inventory,
Quota v2), and the observer, history, completion and Worktree test cases.
They use synthetic identifiers and clocks. They establish contract shape
and client states without qualifying any live producer or permission.

## Implementation ownership

| Package | Paths and integration |
| --- | --- |
| B | Own `server/`, including `server/observer/` after relocating the existing Cargo package. Import `@agent-hub/domain` and project the observer's reads into `API_RESPONSES`. Implement production cursor fencing and SSE scheduling independently of the fixture transport. Coordinate the moved observer path with C. |
| C | Own `terminal/`, terminal test references to the observer, and agreed portable extracts in `packages/view-model/`. Replace direct producer reads with the shared HTTP client, preserve `--pool`, `--demo`, project startup, Back and clipboard, and use execution selectors for bound links. |
| D | Own root `src/`. Adapt the React shell, routing and live hooks using `@agent-hub/domain` and the shared HTTP client. Use the loopback fixture service or injected transport during development. Preserve URL/focus restoration, EN/RU and both themes. |
| Shared client | Coordinate `packages/client/` between C and D. It owns HTTP response validation, cancellation, continuation and fetch SSE. Package A supplies the fixture fetch export, with live client implementation in the migration packages. |

Use root `npm ci --ignore-scripts` with the consolidated workspace lock.
Run `npm run typecheck`, `npm run test:contract` and
`npm test --workspace agent-hub-terminal` after building the Terminal observer.
See the [view checklist](hub-v1-parity.md) for the renderer-level acceptance.
