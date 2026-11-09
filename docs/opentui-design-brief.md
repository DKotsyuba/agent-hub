# Agent Hub: OpenTUI design brief

**Audience:** the agent designing the interface and the owner reviewing it.

**Deliverable:** a terminal UI design and interaction specification, not an implementation.

**Baseline:** Agent Hub checkout at `39f1569642270ae1ca8b9a0654c073ce16b7bb66`, inspected 2026-11-04. Source links below are relative to this repository.

## 1. Assignment

Design a keyboard-first terminal interface for Agent Hub using OpenTUI-compatible building blocks. Agent Hub is a local, **read-only observer** for the Agent MCP family. Its user needs to understand what has been observed, inspect the underlying evidence and move between related records without losing their place.

The current React/Tauri UI is the functional reference, not a required visual template. You may reorganize panels, labels, hierarchy and navigation to suit a terminal. Preserve the capabilities and semantic distinctions marked below. Full-content-area detail views and Back navigation were explicitly approved for the existing product; preserve these unless the owner changes that decision. The design is subject to owner approval before implementation.

Do not implement or activate services, change application code or settings, launch agents/models/checks, or design management controls. No placeholder buttons for possible future actions. A refresh is an observation read, not a request to perform the observed work. Use invented, clearly labeled sample content for mockups.

## 2. Functional inventory: current product

The production UI has six top-level areas. The table describes the **live UI**, with demo-only differences called out separately. Some data depends on compatible producers and observer access; the table is a feature inventory, not a claim that every source is currently available.

| Area | List or overview | Detail and meaningful actions |
| --- | --- | --- |
| Overview | Loaded executions, active/pending executions, available answers; attention items, working executions, recent answers and source summaries. Numbers are derived from loaded, filtered records, not necessarily the whole system. | Open an execution or source; go to all agents. Filter by project, execution status and search. Show Run inventory coverage. |
| Agents | Execution rows with task/project, lifecycle, model, duration and last transcript activity. Status and project filters, search, coverage and continuation. | **History:** read source messages, expand tool messages/metadata, load older history. **Result:** read the complete attributed answer and copy it when available. **Details:** ID, execution sequence, lifecycle, answer availability, delivery and cleanup, silence, working directory, confirmed repository/worktree and source metadata. Related objects are navigable only where supported by evidence. |
| Pools | Two separately labeled lists: standalone Agent Pool and legacy Agent Run pools. Search and source-specific coverage/continuation. The live UI does not infer a project association for pools. | For each source: members, discussion/history, decisions/votes and deliveries, with their own page controls and original metadata. Open a linked Run execution only when a source binding exists. Show leader and open/closed state as reported. |
| Worktree | Working copies with path/name, branch and confirmed repository; source coverage and continuation. Inventory does not automatically inspect status or calculate size. | On opening, read status, integration, processes and submodule observations. An explicit read-only **Measure size** action requests size separately. Show each probe's coverage/reason; size may be a lower bound. Navigate to confirmed repository. |
| Projects | Confirmed repository identities grouped by common Git directory, with count of loaded working copies; search and source coverage. Configured paths alone are not verified repository identities. | Read saved Agent Tasks plan, saved report, individual outcome estimates, findings, evidence/omissions and timestamps; show current-plan/report revision mismatch and pending receipt where present. Open related loaded agents and working copies. Reading does not generate analysis. |
| Tools | Six information sources: Agent Run, Agent Pool, Agent Worktree, Agent Bridge, Agent Tasks and Agent IDE, each with independently reported availability/version. | Run: identity, cached provider quota windows, model/profile compatibility and freshness. Bridge: retained overview counters, deliveries and incidents with pagination and evidence. IDE: installation diagnostics and retained repository observations/checks, repository choice and pagination. Pool/Worktree/Tasks: identity and safe connection diagnostics. Technical source data can be expanded. |

### Global behavior already present

- Project scope is a shared control where a confirmed link is available. In live mode, tools are global and pools have no inferred repository binding. Search is contextual and applies to loaded records, not an authoritative global search. Reset clears scope, status and search.
- Opening a row or a related object enters its full-content-area detail. Back returns to the actual preceding view, restoring its scope, search, selected tab, list position and focus where possible. Direct-entry fallback returns to the relevant list. The current desktop also supports browser Back/Forward; a terminal has no browser history, so specify the equivalent in-app navigation behavior.
- Refresh requests read-only observations. The app shows source, coverage and source observation time where supplied; local receipt time is labeled separately. A source may have no timestamp or total count.
- Interface language is Russian or English. UI labels and structured dates/numbers localize; original task, transcript, report and other producer text does not get translated. Existing preferences are language and system/light/dark appearance, stored locally.
- A result can be copied; success and failure are visibly distinct. Keep a manual text-copy path if terminal/clipboard capabilities permit; do not promise universal clipboard integration.
- Mode is explicit: live observations or intentionally selected synthetic demo. Failed live reads never turn into demo data. The desktop demo also has normal, empty, loading, disconnected, stale and partial scenarios. These are useful design fixtures, not live product states or required production controls.

## 3. Meaning that the design must preserve

1. **Unknown is not empty, healthy or failed.** Distinguish initial loading, a successful empty result, no search matches, partial/incomplete coverage, unavailable/disconnected, incompatible, missing and invalid responses. Design for a retained last-good snapshot after failure with its original observation time and an explicit unconfirmed-freshness label.
2. **Coverage is visible.** Counts identify the loaded subset and total only when reported; continuation and “load older/next page” remain reachable. Do not imply that a first page, source retention window or filtered subset is the whole system.
3. **Independent facts remain independent.** Agent lifecycle, answer availability, delivery state and cleanup state are separate; silence is not proof an agent is stuck. A pool decision is not proof of closure or agent completion; an accepted delivery is not proof of execution completion or understanding.
4. **Attribution matters.** Standalone Pool and legacy Run pool histories remain distinct. A Run execution opened through a binding must not show an answer for a different execution sequence. Results without sufficient source attribution/integrity evidence are withheld with a clear explanation.
5. **Saved Tasks results are dated evidence, not live progress.** Show current plan and report plan revisions separately if they differ. Display per-outcome estimates only if present; do not invent an aggregate percentage. A pending admission receipt does not establish current execution.
6. **Observation limits remain visible.** Worktree probes can be partial and a size can be a lower bound; IDE installation diagnostics do not establish daemon health; Bridge shows retained diagnostics rather than all-time success; Run quotas and model compatibility are cached observations, not permission to launch a model.
7. **Read the whole source text.** Long messages, output, Unicode text and metadata must remain scrollable/readable without losing content; lists may abbreviate with a clear route to the full value. Paths and artifact references are displayed as text, not executed or silently opened.

## 4. OpenTUI and terminal design constraints

- Design in **columns × rows**, with a monospace character-cell grid. Show exact frame sizes, spacing and responsive behavior; do not submit only pixel-perfect web/app mockups. OpenTUI documents boxes, borders, text, scrollable containers, keyboard and mouse events; use these as the design vocabulary, while allowing a distinctive visual style.
- Propose a primary layout at **120 × 40** and a compact layout at **80 × 24** characters. These are design review targets, not claims about an existing minimum. Specify behavior below the chosen minimum and on resizing, including what collapses, scrolls, wraps or moves to detail. Controls and source status must remain reachable.
- Every essential task must work with a keyboard. Specify focus order and visible focus/selection for navigation, lists, search, filters, tabs, expandable metadata, paging and settings. Specify Back, open, scroll, search, refresh and quit keys; show discoverable hints and a help mechanism. Resolve key conflicts with text entry and terminal conventions. Mouse may supplement keyboard access, never be required.
- Give states text or symbols in addition to color. Provide a palette/token description, focus and selected states, and a readable low-color fallback. Account for light and dark terminal backgrounds; do not rely on a particular font, image, hover, pixel positioning, transparency or color alone. Give an ASCII-safe alternative for decorative glyphs.
- Show handling of narrow columns, long paths/IDs, multilingual text and double-width/combining characters. Keep focus visible during live updates, do not jump the reader to new transcript content, and preserve scroll position while loading older messages.
- Define interactions for long, scrollable output and copy success/failure. Terminal selection, clipboard and special key support vary; mark any mechanism that requires implementation or terminal compatibility verification as such.
- OpenTUI's upstream documentation is evolving. At the time of this brief, upstream documents Bun or Node with additional runtime requirements; this is a later implementation decision, not a design deliverable. Sources: [OpenTUI repository](https://github.com/anomalyco/opentui), [runtime support](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/getting-started/runtime-support.mdx), [interaction](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/interaction.mdx), [box](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/box.mdx), [scrollbox](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/scrollbox.mdx).

## 5. Required design handoff

Give the owner and the implementing agent a self-contained package containing:

1. **Information architecture:** all six areas, detail routes, related-object transitions and Back behavior. Identify when project scope and search apply; include paging and source provenance.
2. **Screen designs in character cells:** overview; agent list and agent History/Result/Details; both pool source variants and their detail tabs; worktree list/detail with size action; project list/detail; tools list and representative Run, Bridge and IDE details; settings/help. Equivalent reusable layouts may be shown once if the mapping for every screen is explicit.
3. **States:** loading; successful empty; no matches; partial/unknown coverage; unavailable/incompatible/invalid; stale retained snapshot; missing timestamp/total; answer attribution failure; long content; pagination; copy feedback; a plan/report revision mismatch. Show where each appears and what the user can do.
4. **Interaction specification:** key map, focus order, list selection, tabs, search/filter editing and reset, paging, scrolling, refresh, related navigation, Back, settings and quit. Include behavior when a source changes while the user is reading or when an item disappears.
5. **Responsive and visual rules:** 120 × 40 and 80 × 24 examples plus resize/too-small behavior, color and typography tokens, status/selection/focus treatments, text overflow rules, and at least one realistic Russian and English example with long content.
6. **Traceability:** a checklist mapping every row of section 2 and every rule of section 3 to a design screen, component or interaction. Mark deliberate unresolved decisions for owner review; do not silently omit features.

The handoff should be sufficiently precise that implementation can proceed without inventing navigation, states or data meanings. A mockup is illustrative, not evidence that terminal rendering, clipboard integration, source connectivity or accessibility have been tested.

## 6. Implementation boundary and evidence

- The existing UI calls four Tauri commands (`hub_read`, `hub_watch`, `hub_unwatch`, `hub_connections`), backed by a closed read-only Rust allowlist. An OpenTUI process cannot assume it can invoke the current Tauri window API directly. Preserving the read contracts and selecting or adapting a transport are implementation work after design approval; this brief does not choose an architecture or authorize service changes.
- The app owns no execution database or scheduler. Existing native access uses the Run socket, structured Worktree/Tasks MCP clients, Pool/Bridge observer helpers and IDE read-only diagnostics. Credentials and privileged grants are not design content and must not be displayed.
- Historical project verification records describe six-source isolated fixture coverage and an installed-source smoke for Run, Worktree and Tasks; they do **not** establish that six installed sources are currently working. Producer activation and observer grants had not been completed in that record. No live service was probed for this inventory.
- Primary project references: [application shell and demo](../src/App.tsx), [live views](../src/live/LiveSection.tsx), [source projections](../src/live/protocol.ts), [history and result handling](../src/live/run-details.ts), [read-only integration boundary](integration-boundaries.md), [native read contract](native-read-contract.md), [verification evidence and limits](verification.md), and [project instructions](../AGENTS.md).
