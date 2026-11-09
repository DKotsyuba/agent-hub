# Live integration boundary

The owner approved the visual prototype on 2026-10-20 and authorized the read-only live integration and Tauri build milestone. Preserve the approved full-page detail/Back navigation. English and Russian UI localization is also authorized; source task/message contents remain unchanged.

## Ownership

React renders view models; the Tauri Rust layer owns an explicit read allowlist, bounded socket/stdio clients, validation, pagination and reconnects. Services remain authoritative. The hub owns no execution database, no scheduler, no provider credentials and no direct service database readers. UI preferences and connection settings are the only local app state.

Every view carries source, observed time and coverage. A missing source is unknown, not an empty successful query. Matching names never establish object identity. Agent-to-worktree links use confirmed working paths; repository grouping uses canonical Git common-directory identity.

## Source baseline investigated on 2026-10-20

- Agent Run checkout: 823c4b1984d1052fa08cfcfa2743e8e163accd6a. Installed candidate source: f5dd29d58bc21ccc25100bbec291ba7b0d1eaf0e. Source/install identity does not prove the active broker build.
- Agent Pool candidate: d685697415ea3de690e325dac6d9389125c10d73. Main remains the earlier template.
- Agent Bridge candidate: f55dbb43c5dc0ed611bee1f1fa0c5c81ed06621f. Its SDK/protocol differ from Pool's pinned ae32d1c3 only in the inspected delivery-budget documentation; live compatibility still needs qualification.
- Other family services were inspected in their existing checkouts; preserve unrelated edits and refresh source identities at integration time.

## Implemented read contracts in isolated candidates

| Source | Reuse | Required addition |
|---|---|---|
| Run | Same-user NDJSON JSON-RPC, list_agents dual revisions, transcript cursors, answer proof, models, limits and legacy pool reads | Broker build/capabilities; frame-safe answer metadata and proof-bound answer chunks |
| Pool | Resident store, bounded domain projections and membership/redaction rules | Separate authenticated observer-only ingress, all-pool list, paged roster/history/decisions/deliveries. No new owner or leader model |
| Worktree | Existing list/inspect MCP service and repository identity | Structured output schemas/content preserving Probe uncertainty, numeric size, pagination and coverage; existing text remains compatible |
| Bridge | Counts, incidents_page and exact retention evidence | Server-enforced diagnostics-only grant; bounded content-free delivery list. Never expose the existing unrestricted admin grant to the app |
| Tasks | Agreed flat plan and retained analysis snapshots | Strict read-only peek for plan, saved report and existing pending identity; no collection, inference, submission replay or hidden settlement |
| IDE | Health, diagnostics snapshots, errors and telemetry owners | Bounded repository observation and JSON diagnostics; no actor activation, lease acquisition or check launch |

The Run candidate keeps its existing CLI cutoff and additionally budgets the complete encoded socket frame. Large socket answers retain metadata and use execution/digest-bound chunks. Native and renderer clients reject mixed executions or malformed/incomplete UTF-8 proof data.

Pool's existing resident requests require Current native Bridge assertions, including reads. The desktop observer must not invent an agent session. Keep participant redaction and native leader rules unchanged. No Pool ownership migration belongs in this milestone.

Legacy Run pools and standalone Pool are different source namespaces. Never combine their histories/rosters, infer membership from addresses, or silently replace one source with the other.

## Update and safety behavior

Use Run's revision/message long-poll and transcript cursors. Initial bounded polling defaults: Pool/Bridge summaries 5 s, selected pool history 2 s, visible Worktree/IDE 15 s, cached quota 60 s. Pause hidden work; the app has no background observer after exit. Reconnect invalidates stale responses and rediscovers capabilities. Reads retry with bounded backoff; no write path exists.

Tasks refresh means reading retained results only. A pending or unfinalized report remains explicitly pending; a saved estimate is dated and does not become live progress by passage of time.

Tauri exposes only the closed reading surface to bundled UI. Credentials stay in Rust. Untrusted transcript text never becomes HTML or executable content. Quitting the app closes its clients without terminating agents or resident services.

Future management will be a separate authorized command surface. No speculative command dispatcher, pending-operation journal, management buttons or mutable grants are implemented now.

## Acceptance after visual approval

Verify more than 200 agents and complete source pagination; large Unicode answers; history across resumes; stale response cancellation; service restarts/version differences; unavailable/partial sources; every observer grant denying every mutation; zero model or project-check launches from refresh; and exact output provenance. Run source gates and real macOS Tauri checks before replacing the existing TUI.

## Candidate location and activation boundary

All source candidates remain uncommitted and separate from installed runtimes. No primary-branch integration, publication, installation, resident restart or observer credential provisioning has occurred. Existing TUI remains available.

| Product | Managed candidate path |
| --- | --- |
| Hub | <worktrees>/agent-hub--c6488aad6e86/readable-prototype |
| Run | <worktrees>/agent-run--3a57fc0a19e6/hub-observation-api |
| Pool | <worktrees>/agent-pool--f4797a433d20/hub-observer-api |
| Worktree | <worktrees>/agent-worktree--13c7021e4f48/hub-read-contracts |
| Bridge | <worktrees>/agent-bridge--e107a95ffeaa/hub-diagnostics-api |
| Tasks | <worktrees>/agent-tasks--94f63fca0f10/hub-read-contracts |
| IDE0.10.9 | <worktrees>/agent-ide--cd150066ed0f/hub-observe-api-0109 |
| Family contract docs | <worktrees>/agent-mcp-template--4ee23f8a78ad/hub-read-contracts-docs |

The earlier0.10.8 IDE candidate at <worktrees>/agent-ide--28b222f96bfc/hub-observe-api stays frozen and protected. The current0.10.9 compatibility base is608ee44470288fec870ae89451cae9bebfafd981; this is a source compatibility choice, not an installed-binary provenance claim.

Current-source native smoke reads the existing Run broker and the reviewed Worktree/Tasks candidate frontends without replacing installed programs. Other observer sources stay explicitly incompatible/unconfigured until their reviewed producers and grants are activated. Isolated native fixtures cover all six contracts separately. Full producer gates, native fixture acceptance and actual installed six-source qualification are distinct evidence.
