# Agent Hub: current terminal design

The owner subsequently changed the terminal pool source to standalone Agent Pool. References below to legacy Run pools describe the earlier design iteration; see the terminal README for current source and navigation behavior.

**Status:** revised design, not an implemented terminal application. All canvas values are synthetic.
**Deliverable:** [editable pen.dev canvas](opentui-design.pen).

## Current owner decisions — authoritative over earlier scope

- Startup opens **Overview**, with key Agent Run and Agent Bridge counters and errors. Bridge summary is now in scope; other services remain deferred.
- Main working screen: session list on the left, selected history on the right. `z` expands history fullscreen; `Esc` restores the split and previous focus.
- Active sessions stay visible. Finished sessions are in the collapsed `Finished` group below them. Expanding the group must not reorder the active selection.
- Always show task name, lifecycle, model, project/folder, elapsed duration and last reported action. Missing action/time stays unknown. A reported working directory is not a verified Git repository.
- Show every source message. Tool calls are compact expandable rows; arguments and full output appear on demand.
- Follow incoming history by default. Scrolling upward pauses follow and preserves the reading anchor. `G` jumps to the latest message and resumes following.
- English UI; original source prose remains unchanged. Use OpenCode-like neutral surfaces, restrained accents and bold titles. Keep content compact: no distributed vertical spacing.

## Active review frames

| Frame | Grid | Purpose |
| --- | --- | --- |
| 00 Startup overview | 120 × 40 | Run and Bridge summary; figures describe available observations. |
| 01 Sessions / live split | 120 × 40 | 38-column list, 2-column gap, 80-column history region. |
| 03 History / fullscreen | 120 × 40 | Same selected history and scroll state, with all six requested fields retained. |
| 06 History / scrolled | 80 × 24 | Compact history with follow paused and a new-message indicator. |

Other canvas screens are hidden older studies and are not current visual acceptance targets. The drawing uses 10 × 20 units per terminal cell; implementation uses actual terminal cells. The top bar occupies two rows; the footer occupies the last row. Lists use four consecutive rows per session to retain all six fields, with one blank row between sessions. Messages and tool groups use one blank row of separation. Empty space stays below content. Below 110 columns, the list and history switch full-area rather than squeezing both panes; Back restores the list. Below 60 × 16, show a resize message while retaining help/quit and the underlying navigation state.

## Startup metrics and evidence

The Overview uses three visibly bounded panels: Agent Run, Agent Bridge, and Needs attention. Each source panel contains three equal-width metric cells with a distinct surface and border; each cell pairs its label with its value. Source coverage and observation time sit in one subdued line inside their source panel. Attention rows have a restrained error background, a count/title, period/coverage and an explicit Open action. Long explanations belong in source details; they do not fill the dashboard. On the 120 × 40 grid, source panels occupy rows 5–14 and 16–25, attention rows 27–34, with one-row gutters. Borders and padding must be implemented in terminal cells, not depend on pixel strokes. The Today picker stays above these panels.


- Run: active executions now, finished executions in the selected period, failed executions in the selected period. Failed is a subset of finished, not an additional disjoint total. Preserve source lifecycle distinctions; cancellation or timeout is not silently counted as `failed`.
- Bridge: accepted deliveries in the selected period, pending deliveries now and incidents recorded in the selected period, only when the source explicitly reports the corresponding facts. Delivery counts are not unique message counts. Acceptance is not proof of reading, understanding or execution completion.
- Counts must state their coverage: loaded inventory, reported total, or retained diagnostics. Unknown is never zero. Separate source-read failures from failed executions and delivery incidents.
- Default reporting period: **Today**, with a period picker (`p` on Overview): Today, Yesterday, Last 7 days, Last 30 days. Today runs from midnight in the displayed local timezone to the current observation; Yesterday is the previous calendar day. The last-7/30-day options include today and the preceding 6/29 local calendar days. Use calendar boundaries, including daylight-saving transitions. The example timezone is Europe/Belgrade. Active executions and pending deliveries are current snapshot counts, explicitly labeled `now`, independent of the period. Finished/failed executions use source terminal-event time, accepted deliveries use source acceptance time, and incidents use source recorded-event time. Incidents recorded during the period are not the same metric as currently open incidents. Missing event timestamps cannot be replaced by local receipt time; show the affected period count as unavailable or partial, with its coverage. Changing the period refreshes only read-only observations and never implies complete source retention.
- `Needs attention` links to filtered sessions or to read-only Bridge incident evidence. No retries of deliveries, agent launches or management controls are introduced.
- Refresh reads observations only. Each source has independent time, availability and last-good snapshot labels. A Bridge read failure does not blank Run data or imply zero Bridge errors.

## Navigation additions

Overview is the startup route. Sessions and Run pools remain accessible from the command palette and navigation. `z` toggles focused history fullscreen, `d` opens session details, and `G` resumes follow. Selecting another session updates the right pane while keeping list focus; Enter moves focus into history. Back from fullscreen restores the split, selection and reading anchor. The complete numeric shortcut map will be reconciled with Overview before implementation; old three-section number hints below are historical.

## Retained detailed contracts

The following data-integrity, source and keyboard guidance remains applicable except where explicitly superseded above. Earlier Agent-Run-only scope statements do not exclude the newly requested Bridge summary.

## 1. Scope and design references

The owner's later instructions narrow the first iteration to **Agent Run only** and specify English interface text. The first iteration has three entry points: Sessions, **Run pools** (the legacy pool namespace served by Agent Run), and Run info. Both Sessions and Run pools exist in the current Agent Run TUI and are needed to replace it as an observer. Standalone Agent Pool, Worktree, Projects/Tasks, Bridge and IDE are deferred. They have no placeholder navigation, buttons or fabricated data in this iteration. English is the only interface language specified for this iteration; source-authored text is never translated.

The current [Agent Run TUI guide](../../agent-run/docs/tui.md), its [frame and key bar](../../agent-run/crates/agent-run-tui/src/ui/mod.rs), [session list](../../agent-run/crates/agent-run-tui/src/ui/list.rs), [transcript rendering](../../agent-run/crates/agent-run-tui/src/ui/transcript.rs), [pool rendering](../../agent-run/crates/agent-run-tui/src/ui/pools.rs), and [copy behavior](../../agent-run/crates/agent-run-tui/src/clipboard.rs) are functional references. Keep live/finished grouping, source metadata, transcript/tool expansion, follow, older history, result access, pool discussion and complete-history copy where their read contracts permit. The owner now explicitly prefers a wide list/transcript split, with optional fullscreen history. This supersedes the earlier full-area-only requirement.

Visual direction follows OpenCode rather than inventing a separate dashboard style: neutral background and raised panel, sparse dividers, low-emphasis metadata, warm primary action color, compact status text, contextual side panel when space permits, and a searchable command palette. References: [OpenCode's default theme](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/theme/assets/opencode.json), [session sidebar](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/routes/session/sidebar.tsx), [layout rules](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/ui/layout.ts), [themes](https://opencode.ai/docs/themes/) and [TUI commands](https://opencode.ai/docs/tui/). These links are design references, not a claim of binary or behavioral equivalence.

OpenTUI's [boxes](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/box.mdx), [scrollboxes](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/scrollbox.mdx), [interaction/focus](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/interaction.mdx) and [runtime support](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/getting-started/runtime-support.mdx) supply the design vocabulary. The application must define focus traversal; OpenTUI Core does not provide automatic Tab order. Runtime, component binding, transport, packaging and clipboard mechanism remain implementation decisions after approval.

## 4. Information architecture and data semantics

### Sessions list

- Group known active lifecycle states under `LIVE` and known terminal states under `FINISHED`; put an unrecognized state under `OTHER / UNKNOWN`, displaying its source value. Expand/collapse Finished with `o`. A source-reported total can be shown as such; otherwise label each count `loaded`. A filter never makes a loaded count authoritative for the entire broker.
- Each row shows source task/name, lifecycle as text plus a symbol, model, duration, latest transcript activity or `Not reported`, and workdir basename. Name and task remain source prose. Detail shows the complete name, task, workdir and stable ID. Any user-facing elapsed or silence clock identifies the observation it derives from.
- `p` selects a **working-folder filter**, not a verified repository. It is built from loaded Agent Run working directories and/or a user-entered literal folder prefix; compare at path-component boundaries, without running Git or scanning the filesystem. Explain that worktrees outside the selected prefix are not included. Unknown workdirs do not match a specific folder. `t` filters lifecycle; `/` searches the current loaded list. Search trims surrounding whitespace and matches case-insensitively against loaded session name, task, ID, model, lifecycle and workdir, or against loaded pool goal and ID. It never starts a source-wide search. `x` resets folder, status and search. Mark filtered results and source coverage independently.
- The list retains its selected stable ID, focus, sort/group, expansion, filter state and viewport while a detail is open. Show `n`/a focusable continuation only when the source supplies a continuation. A page is not a total.

### Session detail

`History`, `Result` and `Details` are tabs in the selected session pane, which can be expanded fullscreen. Open `History` by default; `a` opens Result. Keep agent ID and execution sequence visible at the top. The optional context sidebar repeats facts already in the detail or its context block; it never supplies a supposedly verified repository. The selected tab has a text marker as well as color.

**History:** display source role, original timestamp when reported, complete source text and explicit incomplete-block markers. Preserve original formatting and control characters safely: remove or neutralize terminal escape/control sequences so untrusted output cannot act on the terminal. The displayed sanitized value must not silently lose an indicated omission. A user message longer than five visual lines initially shows four and an omitted-line count; Enter reveals the full available text. Tool rows start collapsed and expand to their complete available arguments, results and metadata. Assistant prose is not silently shortened. The current TUI combines tool calls and results only when the known native reference and tool identity actually match, without crossing a source block or execution boundary; an unmatched result stays separate. Report `[error]`, `[ok]` or `[unknown]` from explicit source flags only; no keyword inference. A pending tool with no result is not a success.

On initial entry, show the latest available page with follow on; restoring an existing view preserves its previous follow setting. `g` loads the previous page if the source exposes one; `G` moves to the tail and enables follow; `f` toggles follow. Scrolling away turns follow off. New messages increase an unobtrusive counter and do not move a reader who is not following. When older history is prepended, anchor the same message and in-message display row, including after rewrap. Explicitly label source-declared partial blocks, missing bodies, unavailable older pages and incomplete coverage. Expand/collapse state is keyed by message identity and survives refresh and Back.

**Result:** display only complete text whose agent ID, sequence and integrity are established under the source contract. Label absence, in-progress/unavailable result, unsupported chunks and failed or missing proof distinctly; do not substitute an earlier or later execution's answer. Raw paths/references are shown as text, not read from the filesystem. `c` copies only a complete attributed answer; show `Copied` or `Copy failed` and, on failure, offer terminal text selection where the terminal supports it. Answer availability is not execution completion or delivery acceptance.

**Details:** show stable ID and sequence, lifecycle, answer availability, delivery, cleanup, silence, working directory, model, duration, last activity, source/receipt times and expandable producer metadata. `Silence 2m` is an observation, never `stuck`. If Run supplies token, cache, turn, cost or tool-outcome statistics, show their scope and source observation; leave unreported values unknown. Show a lineage total only when explicitly reported and distinguish it from this execution. `Unknown` is not zero. A Run workdir is not by itself a verified Git repository.

### Run pools

The list and every detail are labeled `Agent Run · legacy pools`. Show open/completed states only when reported. Keep source-provided leader, goal/criteria, state, agreement, proposal, delivery/ambiguity, history watermark and coverage independent. Never combine these records with standalone Agent Pool history. A pool is not assigned to the selected folder by name or assumption.

The common detail has four tabs:

| Tab | Content and behavior |
| --- | --- |
| Members | Source member/role, execution state, cleanup, raw vote, whether it counts and the reason, plus replacement history where reported. Open a Run session only with a source-supplied binding. |
| Discussion | Original ordered entries, source author/role, sequence and kind, expandable full text/metadata and independent older/newer page controls. Label content untrusted; do not invent timestamps. Keep scroll anchor on updates. |
| Decisions | Source proposal/criteria, votes, vote validity/reasons and source agreement. An accepted decision or unanimous vote is not proof that the pool is closed or executions completed. |
| Deliveries | Original delivery and ambiguity fields, with independent source state and metadata. Accepted delivery does not establish execution completion or understanding. |

Page controls appear for the current source cursor only. When the source supports separate earlier/newer pages, show both and retain the selected page/scroll when switching tabs or returning from a related session. If opening a member only identifies a stable session but not an execution sequence, explicitly label it as the **current session**; do not attribute a historical pool result to it. If an exact sequence is supplied but is not loaded or no longer matches, withhold the answer and offer a source continuation/refresh where available. Back returns to the exact pool tab, entry/member, focus and scroll.

### Run info

Show broker connection and source identity/version when reported, independently timestamped cached provider quota windows, model/profile compatibility, and original safe metadata. Show each cache's observation time and freshness independently. A quota or compatibility snapshot is not authorization to start work, and absence is not a zero quota or a failed model. This page has no launch, configuration or provider-management control.

## 5. Keyboard, focus and navigation

These keys apply when no text field or overlay owns input. Visible hints show the relevant subset; the full `?` guide and the `Ctrl+P` command palette expose all available read-only commands. If `Ctrl+P` is intercepted by the terminal, `?` remains reachable and lists the same actions. Mouse can select, open, scroll and expand, but none is required.

| Key | Behavior |
| --- | --- |
| `1`, `2`, `3` | Navigate to Sessions, Run pools, Run info. Push a view-history entry. |
| `Tab`, `Shift+Tab` | Move focus forward/back through visible regions and enabled actions; wrap at the ends. |
| `↑`, `↓`, `j`, `k` | Move selection within the focused list, or scroll a focused text region. |
| `PgUp`, `PgDn`, `Home`, `End` | Scroll the focused region by page or to its edges; End on history moves to the tail and enables follow. |
| `Enter`, `Space` | Open focused row, activate a button, or expand/collapse a focused block. |
| `←`, `→` | Switch tabs only while the tab strip is focused; otherwise keep normal text-navigation behavior. |
| `/`, `p`, `t`, `x` | On applicable lists: edit loaded-record search, choose working folder, choose lifecycle, reset all three. |
| `o`, `n` | Toggle Finished; load the next page of the focused source inventory, including an explicitly offered inventory continuation in a detail. Pool discussion has its own earlier/newer cursor controls. |
| `g`, `G`, `f` | In history/discussion: load older if available, go to latest and follow, toggle follow. |
| `m`, `d`, `v` | In a Run pool detail: switch to Members, Decisions or Deliveries. Discussion remains reachable through the focused tab strip. |
| `a`, `c`, `y` | In a session: open Result, copy verified answer, copy complete session history; `y` in Run pool discussion copies complete pool history. |
| `r` | Refresh visible read-only observations. Never launch work, generate a report or mutate a pool. |
| `Esc`, `F` | Close the top overlay/cancel an edit first; otherwise Back to the actual previous view. `F` moves forward through the in-app history when available. |
| `Ctrl+P`, `?`, `,` | Read-only command palette, help, local appearance settings. |
| `q`, `Ctrl+C` | Quit the observer and its own connections; do not stop the broker or any observed execution. |

Focus order on a list is navigation → filters/search → list/group headers and rows → page controls → source/coverage → footer actions. On a detail it is Back → tab strip → body/expandable blocks and related items → page/copy actions → source/coverage → footer actions. A modal traps focus, opens on its first enabled control, and restores the invoker on close. `>` plus a high-contrast row indicates keyboard focus; a separate persistent marker indicates the selected row when focus is elsewhere. Neither depends on color alone.

In a text field, printable keys—including digits, `q`, `/`, `F` and `?`—edit text rather than invoke app commands. `Enter` commits the draft; `Esc` restores its pre-edit value and focus. A picker uses arrows, Enter to commit and Esc to cancel. Reset is an explicit current-view action, not an implicit navigation. A section jump or related-object opening records a new history entry; changing filters or the selected tab updates the current entry without adding a separate Back step. Each entry captures route and exact source namespace/identity/sequence, filters, selected tab, expanded blocks, selected stable item, focus target and scroll/message anchor. Back and forward restore that snapshot. A new navigation after Back discards the forward branch. A direct-entry detail without prior history falls back to its corresponding list.

If an update reorders rows, retain selection by source identity and keep the focused row visible. If the selected item disappears, keep the detail or last-good evidence when safe and label `Not in the loaded snapshot`; do not silently move to a different identity. On Back to a list, focus the same item if present; otherwise focus the nearest surviving row and announce `Previously selected item is no longer in the loaded list`. No stale response may replace a newer view, selection or execution sequence.

## 6. Source state and evidence rules

States attach to the affected source, inventory, page, tab or field, rather than to the entire app unless the whole source is affected. A banner preserves usable content and actions; an initial failure without retained content has a single clear explanation and retry.

| Condition | Visible English copy / interpretation | Available action |
| --- | --- | --- |
| First read pending | `Loading observations…` | Back/help/quit remain available. |
| Successful, truly empty source window | `No sessions in the reported window` or `No pool entries in the reported window` | Refresh; continuation if supplied. Do not assert global emptiness. |
| No local filter matches | `No matches in loaded records` | Edit/reset filter; load more if available. |
| Partial or unknown coverage | `Coverage partial` or `Coverage unknown`; `Loaded N of M` only if source reports M | Inspect coverage; load continuation when supplied. |
| Missing total or source clock | `Total not reported` / `Source time not reported` | Keep the local receipt separately labeled; never substitute it as source time. |
| Unavailable / disconnected | `Source unavailable` and a safe reason | Read-only retry. |
| Unsupported version or operation | `Source incompatible` and the unavailable capability | Inspect source information; no fallback to mutating methods. |
| Missing source value | `Not reported` / `Missing`, as appropriate | Inspect metadata; never render zero or success. |
| Invalid or malformed response | `Invalid source response` with safe diagnostic code | Retry or inspect metadata; never render malformed data as success. |
| Failure after a usable snapshot | `Last good snapshot · freshness unconfirmed`, original source time and its original local receipt; separately label failed receipt | Read-only retry; keep last-good data visually marked until confirmed. |
| Sequence mismatch, missing proof or digest failure | `Answer withheld · attribution or integrity not established` with reason | Load source inventory or retry when available; no answer/copy. |
| Long or source-truncated content | Wrap/scroll full available text; `Source marked content incomplete` when applicable | Expand, scroll, load older if possible. |
| More source data | `Loaded N; total not reported` or `Loaded N of M`, plus continuation and scope | Load next/older/newer page through its own cursor. |
| Copy complete answer | `Result copied` or `Copy failed` | Retry or manually select rendered answer if terminal selection works. |
| Copy complete history | Progress, success, canceled, failure or explicitly unknown result after a raced clipboard commit | Cancel before commit; incomplete/unknown-coverage export must not be represented as complete. |

Full-history copy preserves the old Agent Run TUI's useful contract: capture the selected session execution or pool and a frozen source watermark, fetch all required pages, preserve source attribution and do not claim a complete copy if a page/body is unavailable, omitted, partial or has unknown coverage. The old TUI bounds this operation; equivalent limits and clipboard access require implementation and terminal/platform verification. The selected target cannot change when the reader navigates during a copy. Do not promise universal clipboard support or silently write a partial export. An uncertain clipboard commit is `Copy outcome unknown`, not success or failure.

`Live` and `Demo` are explicit startup modes and always visible. In demo, the records are clearly synthetic and no live connection is implied. A live failure never switches mode or invents a demo snapshot. Local preferences can change appearance only; they cannot edit service configuration or provision access.

### Language examples

Interface labels remain English. The two source passages below illustrate content handling, not interface translations:

- English source message: `Please inspect the saved history and include /home/demo/projects/agent-hub/worktrees/really-long-feature-name/artifacts/execution-log.json in your findings. Do not omit records that need another page.` It wraps and remains fully scrollable.
- Russian source message, displayed unchanged under the English `ASSISTANT` heading: `Проверил сохранённую историю запуска. Часть сообщений находится на предыдущей странице; путь /home/demo/projects/agent-hub/worktrees/very-long-branch-name/results/observation.json приведён как текст.` It wraps on the same cell rules and is not translated.

## 7. Palette and non-color fallback

The visual sample uses OpenCode's neutral dark family: background `#0a0a0a`, panel `#141414`, selected surface `#323232`, primary text `#eeeeee`, secondary text `#a4a4a4`, separator `#484848`, primary action `#fab283`. Source status can additionally use the reference palette's success `#7fd88f`, warning `#f5a742` and error `#e06c75`. Every status also has a word and, if useful, a symbol. Selection uses `>` and focus uses a distinct row treatment; use a visible inverse/underline or boundary in low-color mode. Decorations such as `─`, `▸`, `↑` and `←` have ASCII alternatives `-`, `>`, `^` and `<`.

The light sample uses `#ffffff` background, `#fafafa` panel, `#e1e1e1` selection, `#1a1a1a` text, `#595959` secondary and `#2968c3` action. `System` follows the terminal when reliably detectable; otherwise use terminal-default foreground/background with readable contrast. Support a 16-color or monochrome terminal without relying on background shade, color alone, transparency, a special font, hover, or pixel coordinates. Verify real terminal contrast, wide/combining-character widths and selected text in both modes; the pen.dev drawing is not a terminal accessibility test.

## 8. Traceability and deferred scope

| Original brief requirement | First-iteration disposition |
| --- | --- |
| Overview | Session inventory and Run source summary, frames 01/13; aggregate cards and other-source overview are deferred. |
| Agents | Sessions list plus History/Result/Details, frames 01/03–06/11/13. |
| Pools | Agent Run legacy pools only, frames 02/07/08; standalone Agent Pool deferred. |
| Worktree | Deferred: no inventory, inspection, size action or implied repository verification. |
| Projects / Tasks | Deferred: no saved plans, reports, estimates or revision-mismatch screen; Run folder filter is not a verified project. |
| Tools | Agent Run identity, quota and compatibility only, frame 09; Pool/Worktree/Bridge/Tasks/IDE source screens deferred. |
| Shared scope/search/reset | Section 4 Sessions list and section 5; scope is explicitly a Run workdir prefix, not a Git identity. |
| Full-area detail and actual Back/Forward | Sections 3 and 5. |
| Refresh, source/coverage/time | Sections 4 and 6; frames 01/09/10. |
| Localization | Owner specifies English interface for iteration 1; source text stays original. Language switching is deferred. |
| Copy and mode | Sections 4 and 6; frames 04/10/11; modes are explicit. |
| §3.1 Unknown, empty, failed, stale | Section 6 and frames 10/11. |
| §3.2 Coverage, totals and pagination | Sections 4–6 and list/detail page controls. |
| §3.3 Independent lifecycle, result, delivery, cleanup, silence and pool decisions | Session Details and all Run pool detail tabs, section 4. |
| §3.4 Source namespace and answer attribution | Run pool labels and session Result, sections 4/6. Standalone Pool is not in this iteration. |
| §3.5 Saved Tasks revisions, estimates and pending receipts | Deferred with the Tasks source; none is fabricated. |
| §3.6 Observation limits | Run coverage, cached quota and compatibility, section 4. Worktree, IDE and Bridge limits are deferred with their sources. |
| §3.7 Full source text, Unicode and inert paths | Sections 3, 4 and 6; frames 03/04/06/07. |

## 9. Implementation boundary and review

This is a visual and interaction design only. Agent Hub currently exposes four Tauri-window commands backed by a closed read-only Rust allowlist; an OpenTUI process cannot assume that window API is available. The replacement transport must retain the existing read/attribution guarantees and be designed and reviewed after approval. This handoff does not select Bun versus Node, install dependencies, change a service, provision access, start an agent/model/check, probe live services or remove the existing TUI.

Before claiming implementation acceptance, verify the selected OpenTUI runtime and terminal capabilities, focus and keyboard navigation, 120 × 40 and 80 × 24 resizing, light/dark/low-color contrast, Unicode and complete long text, bounded pagination/follow anchors, stale snapshots, sequence-fenced answers, pool provenance, copy failures and no mutation paths. The canvas has been inspected as a design; it does not prove any of those runtime properties or current service availability.
