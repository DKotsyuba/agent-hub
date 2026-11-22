# Hub view models

`src/index.ts` exposes browser-safe helpers shared with the terminal.

- `assembleText`, `TextPage` and `verifyText` assemble byte-contiguous
  UTF-8 pages under a caller-supplied proof or revision fence and verify the
  full SHA-256 digest when one is available.
- `projectQuotaSnapshot` and `projectQuotaStatus` convert v1 DTO clocks from
  milliseconds to the seconds used by the presentation model. The Quota
  models and functions in `quota.ts` expose nullable measurements, coverage,
  validity, exhaustion latches, summary, and presentation.
- `branchLabel` and `formatBytes` are pure Worktree display helpers. Labels
  use the same binary units and detached-HEAD representation as the terminal.
