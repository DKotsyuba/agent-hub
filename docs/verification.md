# Agent Hub verification

Observed 2026-10-20. Browser, native client, isolated producer fixtures and installed-service qualification are separate evidence. No publication, installation or service activation is implied.

## Browser prototype and f2383 integration results

- TypeScript check and production Vite build passed.
- WebdriverIO acceptance script passed all 11 behavior groups.
- Axe WCAG A/AA scan reported no violations in 24 rendered states. No severe browser console errors or external resource requests were observed.
- Verified 1440x900 and 1100x720 viewports, the narrow in-app panel, light/dark themes, keyboard focus and 200% root text (body30px). The enlarged view reflows without clipped selector values or search-shortcut overlap. Screenshots were visually inspected.
- Whole-row hover/click, one history entry per activation, full content-area details, nested Back, browser Back/Forward, retained filters/tabs/scroll/focus and direct-entry fallback were checked.
- The History API receives zero writes during the 2000-event scroll/focus regression. Cached snapshots retain navigation state without event-level replaceState calls.
- Clipboard rejection has a warning/alert, and stale tool details consistently identify saved observations with unconfirmed freshness.
- Official shadcn component hashes remain unchanged.

## Reproduction

Use the prepared dependencies and explicit browser/driver paths documented in scripts/browser-support.mjs. Run npm run typecheck, npm run build, npm run preview, then npm run test:browser in another terminal. The preview binds only127.0.0.1:4173. Test artifacts, browser profiles and logs are below <tmp-root>/agent-hub; the test must not download browsers or use the owner's profile.

Fresh evidence: <tmp-root>/agent-hub/artifacts/browser-check.json and adjacent PNG files.

## Scope and approval

The owner requested full-screen details with Back instead of split panes, and whole-row hover/click targets. Both revisions are implemented. The owner approved this prototype on 2026-10-20, then authorized read-only tool integration, Tauri and EN/RU localization. Evidence above belongs to the prototype source identities below; it does not establish later native integration acceptance. Live read probes of Agent Run were performed separately. No application installation, publication or management operations are claimed. A screen-reader session remains unverified. Current native evidence is recorded separately below.

## Historical prototype source identities

| File | SHA-256 |
| --- | --- |
| src/App.tsx | d75465f7910302e78e11efd1762188f646d34acf4001c528459b8988f6cf3dbf |
| src/app.css | 8099259dd26fb87e2f9470e2381556974f74cdefde797de76c0ff8c7bb3d4a1e |
| src/demo.ts | f72f6075e6c1c8509745e6d1218bfaba5cd754a8369e70ec8bf8fa3c887e0b00 |
| src/main.tsx | 6c9c8febcd43bf74972b3568edede44e2ca47eafc67e33236d0c1a07a7eac4a1 |
| package-lock.json | b1bac8d2d0621b444c759e9d2804218f7bc0f1cf1574d1c040d9ee34d2d078be |
| scripts/browser-check.mjs | b89f710d192c51d747cd16038470e8e0f2c59deeb2f910aa24209a173fa57ddf |
| scripts/browser-support.mjs | 2ba14b5d4b6b4601a012741f6362dc82ac6133cf4f1532e3992b492794a1d7d2 |

## Current frontend snapshot

Frozen first-party source digest 42bee1103e00192cf3b357f253e03a0eaf560422f36f21342b125871e1ebc98e; manifest <tmp-root>/agent-hub/artifacts/frontend-ready-42bee1103e00.json. Root recomputed all16 source and3 asset hashes after native acceptance; no drift. Typecheck, focused read-check, production build and EN/RU key parity passed. The earlier11 browser groups/24 axe states above belong to f2383; the current exact bundle has the native evidence below.

Independent review covered live validation/paging, execution/generation fences, UTF-8 proof-bound answer reconstruction, navigation and typed source projections. Changed-only follow-ups cleared the stale rejected-diagnostic recovery, compact overview, Bridge tabpanel relationships and bounded full-text scrolling. No actionable finding remains in those reviewed areas. History and result keep their entire plaintext in keyboard-focusable bounded scroll regions; source text is never truncated for layout.

## Native shell and package

The reviewed closed native seam passed35 targeted Rust tests, all-target check, strict Clippy and rustfmt. Three lifecycle findings (MCP cancellation ordering, early helper stdin closure and legacy exit classification) have regression coverage and were cleared by independent changed-only review.

A default-feature local macOS arm64 debug app was built with --no-sign. Preserved app: <tmp-root>/agent-hub/native/apps/default-42bee1103e00/Agent Hub.app. Its executable SHA256 is966049d56886a14f77210bce67adca82b96e8a563884926bae88c33c5c2b343f (40195816bytes). Cargo metadata excludes the optional test driver by default; this binary contains none of native-acceptance-focus, TAURI_WEBDRIVER_PORT or tauri_plugin_wdio_webdriver. The linker supplies its ordinary ad-hoc signature; this is not a distribution-signed/notarized or optimized release build.

The separate native-e2e debug app executable SHA256 is0f74fdb276bc685d01e7845045ac8b114741baad1db072c2020addb58093a8c7, preserved inside <tmp-root>/agent-hub/native/apps/e2e-0f74fdb276bc685d/Agent Hub.app. Its test-only configuration grants own-app show and own-window show/focus, uses nonpersistent storage and keeps the acceptance window visible across workspaces. These grants and the optional driver are absent from the normal app. No visibility, keyboard trust or focus APIs are spoofed.

## Current six-source native acceptance

The actual WKWebView-to-Rust application passed10/10 scenario groups and39 rendered Axe WCAG A/AA states with zero violations, using isolated real Unix/MCP/CLI producer fixtures. Native IPC itself was not mocked. Evidence: <tmp-root>/agent-hub/native/session-5LGqu0/native-ui-check.json and adjacent PNGs; process exit0. Root visually inspected the1440x900 light overview,1100x720 dark agent list,200% overview and Bridge detail screenshots.

Verified behavior includes237-record pagination, independent watches and retained list navigation; obsolete execution/answer fences; dated last-good observations during source failure;23-worktree paging and explicit inspection; retained Tasks results without generation; separate standalone/legacy Pool namespaces; votes, decisions and delivery states; observer tool pages and version rediscovery. Full native coverage includes1440x900/1100x720, light/dark, all six main views and200% root text.

Five genuine native keydown events were recorded with isTrusted=true, the exact expected DOM target and real visible/focused state: retained-row Enter, internal-result PageDown, large-answer settings Escape, later-list Enter and200% settings Escape. The724943-byte Unicode result remained complete, proof-bound and copyable through the recording sink; its945866px plaintext content stayed inside a585px scroll region while document height was1287px. Done/Escape removed the complete portal and restored pointer actions. Collapsed-metadata detection has an actual open/close positive control.

Closing the last owned window exited the app. All133 owned helper processes were reaped, the fixture server closed and zero sockets remained. Earlier setup/harness failures, the interrupted quiet-window attempt and all old reports remain retained; they are not counted as successful scenarios. Clipboard tests restore the recording sink; OS pasteboard read/write and a screen-reader session remain unverified.

## Installed-source read smoke

Root repeated six successful native IPC reads on the final42bee bundle: Run identity/agent inventory, Worktree identity/list and Tasks identity/retained peek. Native mutation resources and generic shell commands were refused. Current evidence: <tmp-root>/agent-hub/native/session-tYOIXm/ipc-check.json and native-ipc.png, process exit0 with110 actual Run records and20 Worktree rows. Earlier evidence remains under session-vv3jC7 and session-8xlPu9. The real populated window was also observed through macOS accessibility.

This configuration points to the resident Run broker and reviewed Worktree/Tasks candidate frontends. It does not install candidates or enable Pool/Bridge/IDE observers. The older Run broker legitimately reports unknown build because it lacks capabilities discovery. The final-source real-read smoke and isolated matrix exercise the same preserved native-e2e binary.

## Producer qualification and remaining activation boundary

| Candidate | Required local gate |
| --- | --- |
| Agent Worktree structured observations | Passed |
| Agent Tasks retained peek | Passed |
| Agent Pool owner observer | Passed |
| Agent Bridge diagnostics observer | Passed, including native ownership isolation regression |
| Agent Run capabilities/proof-bound answer chunks | Passed full required gate9, both complete feature/default test and doctest modes, Clippy, default all-target check, strict rustdoc and final contracts |
| Agent IDE0.10.9 observation/read-only doctor | Full gate b remains failed; subsequent core56/56, TS profile17/17, Rust module17/17 and37/40 original product cases passed. Latest two fixes are uncompiled during resource hold |
| Agent MCP Template optional read-contract guide | Passed; canonical/scaffold copies match |

The Agent IDE0.10.9 candidate routes batch symbol/graph/test requests directly to their batch owners, preserving boxed per-entry work and the default stack budget. Existing regressions reproduce both earlier stack overflows and pass after that routing correction. Fixture repairs preserve the existing provider identity, no-spawn, exact replay and full-source pagination contracts; independent review found no weakened assertion.

The Agent IDE0.10.9 candidate uses its existing public rendezvous-parent option for isolated default controls. The earlier0.10.8 temporary-path blocker is historical and is not claimed for this candidate.

Actual six-source installed qualification remains separate and requires reviewed producer activation plus explicit observer grants. The owner deferred service configuration for this first version. No publication, installation, daemon restart or observer grant provisioning has occurred. Existing TUI remains available. Run gate9 evidence is <tmp-root>/agent-run/hub-observation-api-xtask-check-9-fifo-fixed-threads1.log plus exit/metrics sidecars: exit0,438 test summaries with4710 passed and zero failed invocations across both modes,25 intentional ignores. Earlier failed gates remain retained; the serial-only FIFO failure was test-output framing, corrected without changing assertions or deadlines. The completed IDE gate b exited1 after its no-fail-fast workspace stage (1969 passed,45 failed,83 ignored); later default controls, provider qualification and final checks were unreached. Exact log: <tmp-root>/agent-ide/build/hub-observe-api/gate-port-608ee-20261020b.log. The18 focused regressions also passed inside this gate. Subsequent unchanged-budget catalog regeneration measured7990/8000 Claude bytes and7201/7500 Codex bytes, ten tools unchanged. New metadata/TypeScript/Python/fixture/R5 hunks passed independent changed-only static review; all41 source fingerprints matched the sealed checkpoint. The last two renderer/status-prefix fixes remain uncompiled, and one activation failure remains an unproven intermittent despite an isolated pass. Resource hold prevents further heavy compilation near the8GiB reserve; only completed Pool/Bridge cache cleanup has been prepared for separate approval. Further shared-fixture/catalog corrections require their own focused checks and changed-only review before another genuine full gate. Final IDE acceptance and the complete immutable source handoff remain pending.
