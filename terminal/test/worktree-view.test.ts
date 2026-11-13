/** Worktree view model: size formatting, change summary, merge mapping, ordering, unknowns, summaries and narrow flow. */
import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import {
  LARGE_BYTES, activityWord, changeCount, changeDetail, changeSummary, compareWorktrees, flowChips, formatBytes, mergeBadge, mergeState, orderedWorktrees,
  projectSummary, projectViews, sizeSummary, tabSummary, tabSummaryText, technicalLines, worktreeBody, worktreeView,
} from '../src/worktree-view.ts';
import type { FactsEntry, ProjectView, SessionCount } from '../src/worktree-view.ts';
import type { StatusCounts, WorktreeFacts, WorktreeGroup, WorktreeRow } from '../src/worktree.ts';

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const none: SessionCount = { total: 0, active: 0 };
/** One listed row with overridable fields. */
function row(key: string, over: Partial<WorktreeRow> = {}): WorktreeRow {
  return { key, class: 'managed', path: `/work/${key.split('/').pop()}`, branch: `refs/heads/${key.split('/').pop()}`, detached: false, head: 'a'.repeat(40), repoId: 'r', repoCommonDir: '/repo/.git', activity: 'idle_candidate', mtimeBased: true, integration: 'unmerged', removalStarted: false, creator: null, ...over };
}
/** A finished inspection with the given counts and size. */
function ready(counts: Partial<StatusCounts> | null, bytes: number | null, lowerBound = false): FactsEntry {
  const facts: WorktreeFacts = {
    status: counts ? { state: 'known', value: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ...counts }, lowerBound: false } : { state: 'unavailable', code: 'probe_timeout' },
    size: bytes === null ? { state: 'unavailable', code: 'size_budget' } : { state: 'known', value: bytes, lowerBound },
  };
  return { state: 'ready', facts };
}
/** Joins spans to text. */
const text = (spans: { text: string }[]) => spans.map(item => item.text).join('');
const group = (repo: string | null, rows: WorktreeRow[], extra: Partial<WorktreeGroup> = {}): WorktreeGroup => ({ repo, rows, coverage: { repos: 1 }, partial: false, error: null, ...extra });

test('sizes use binary multiples with one decimal below ten and never round up past the unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024), '10 KB');
  assert.equal(formatBytes(640 * 1024), '640 KB');
  assert.equal(formatBytes(MiB), '1.0 MB');
  assert.equal(formatBytes(Math.round(1.2 * GiB)), '1.2 GB');
  assert.equal(formatBytes(Math.round(12.4 * GiB)), '12 GB');
  assert.equal(formatBytes(MiB - 1), '1.0 MB', '1023.999 KB is promoted, never shown as 1024 KB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
  assert.equal(formatBytes(5000 * 1024 ** 4), '5000 TB', 'the largest unit does not roll over');
  assert.equal(formatBytes(-1), 'Unknown');
  assert.equal(formatBytes(Number.NaN), 'Unknown');
});

test('the producer integration code maps to a merge badge; the main checkout is the target and unknown stays unknown', () => {
  assert.equal(mergeState(row('a', { integration: 'ancestor_merged' })), 'merged');
  assert.equal(mergeState(row('a', { integration: 'unmerged' })), 'not_merged');
  assert.equal(mergeState(row('a', { integration: 'unknown' })), 'unknown');
  assert.equal(mergeState(row('a', { integration: null })), 'unknown', 'a row that was not probed is unknown, not merged');
  assert.equal(mergeState(row('a', { integration: 'something_new' })), 'unknown');
  assert.equal(mergeState(row('a', { class: 'main', integration: 'ancestor_merged' })), 'main');
  assert.deepEqual(mergeBadge('merged'), { text: 'MERGED', tone: 'good' });
  assert.deepEqual(mergeBadge('not_merged'), { text: 'NOT MERGED', tone: 'warn' });
  assert.deepEqual(mergeBadge('unknown'), { text: 'UNKNOWN', tone: 'muted' });
  assert.deepEqual(mergeBadge('main'), { text: 'MAIN', tone: 'muted' });
});

test('activity bands become plain words and mtime-based estimates say so', () => {
  assert.deepEqual(activityWord({ activity: 'idle_candidate', mtimeBased: true }), { text: 'idle · mtime-based', tone: 'muted' });
  assert.deepEqual(activityWord({ activity: 'recent', mtimeBased: true }), { text: 'recent · mtime-based', tone: 'text' });
  assert.deepEqual(activityWord({ activity: 'stale_candidate', mtimeBased: true }), { text: 'stale · mtime-based', tone: 'muted' });
  assert.deepEqual(activityWord({ activity: 'recent~', mtimeBased: false }), { text: 'recent · mtime-based', tone: 'text' }, 'the ~ marker is the same flag');
  assert.deepEqual(activityWord({ activity: 'active', mtimeBased: false }), { text: 'active', tone: 'good' });
  assert.deepEqual(activityWord({ activity: 'active', mtimeBased: true }), { text: 'active', tone: 'good' }, 'a process-verified state is never labelled an estimate');
  assert.deepEqual(activityWord({ activity: 'unknown', mtimeBased: true }), { text: 'activity unknown', tone: 'muted' });
  assert.deepEqual(activityWord({ activity: 'brand_new_band', mtimeBased: true }), { text: 'activity unknown', tone: 'muted' });
  assert.equal(activityWord({ activity: null, mtimeBased: false }), null);
});

test('changes: clean, counted with a breakdown, conflicts in red, and every unknown stays unknown', () => {
  assert.equal(changeCount({ staged: 1, unstaged: 3, untracked: 1, conflicts: 0 }), 5);
  assert.equal(changeDetail({ staged: 1, unstaged: 3, untracked: 1, conflicts: 0 }), '3 modified · 1 staged · 1 new');
  assert.equal(changeDetail({ staged: 0, unstaged: 0, untracked: 0, conflicts: 2 }), '2 in conflict');
  assert.deepEqual(changeSummary(ready({}, 1)), { text: 'clean', detail: '', tone: 'good', count: 0, lowerBound: false, conflicts: 0 });
  const dirty = changeSummary(ready({ staged: 1, unstaged: 3, untracked: 1 }, 1));
  assert.equal(dirty.text, '5 changes');
  assert.equal(dirty.detail, '3 modified · 1 staged · 1 new');
  assert.equal(dirty.tone, 'warn');
  assert.equal(changeSummary(ready({ untracked: 1 }, 1)).text, '1 change');
  assert.equal(changeSummary(ready({ conflicts: 1, unstaged: 1 }, 1)).tone, 'error');
  assert.equal(changeSummary(ready(null, 1)).text, 'changes unknown', 'a failed status probe is never shown as clean');
  assert.equal(changeSummary(ready(null, 1)).count, null);
  assert.equal(changeSummary(undefined).text, 'changes: queued');
  assert.equal(changeSummary({ state: 'pending' }).text, 'changes: checking…');
  assert.equal(changeSummary({ state: 'failed', code: 'source_error' }).text, 'changes unknown');
  assert.equal(changeSummary({ state: 'ready', facts: { status: { state: 'not_checked', code: null }, size: { state: 'not_checked', code: null } } }).text, 'changes: not checked');
  const bounded = changeSummary({ state: 'ready', facts: { status: { state: 'known', value: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, lowerBound: true }, size: { state: 'not_checked', code: null } } });
  assert.equal(bounded.text, '≥0 changes', 'an incomplete status walk is not clean');
});

test('size: human text, lower bound, large threshold, and an unmeasured size is never zero', () => {
  const sized = sizeSummary(ready({}, Math.round(1.2 * GiB)));
  assert.equal(sized.text, 'size 1.2 GB');
  assert.equal(sized.bytes, Math.round(1.2 * GiB));
  assert.equal(sized.tone, 'text');
  assert.equal(sizeSummary(ready({}, 0)).text, 'size 0 B', 'a measured empty folder is zero, an unmeasured one is not');
  assert.equal(sizeSummary(ready({}, LARGE_BYTES - 1)).large, false);
  const large = sizeSummary(ready({}, LARGE_BYTES));
  assert.deepEqual([large.large, large.tone, large.text], [true, 'warn', 'size 2.0 GB (large)']);
  assert.equal(sizeSummary(ready({}, 3 * GiB, true)).text, 'size ≥3.0 GB (large)');
  for (const entry of [undefined, { state: 'pending' } as FactsEntry, { state: 'failed', code: 'x' } as FactsEntry, ready({}, null)]) {
    const unknown = sizeSummary(entry);
    assert.equal(unknown.bytes, null);
    assert.equal(unknown.tone, 'muted');
    assert.doesNotMatch(unknown.text, /\b0 B\b/);
  }
  assert.equal(sizeSummary(undefined).text, 'size: queued');
  assert.equal(sizeSummary({ state: 'pending' }).text, 'size: measuring…');
  assert.equal(sizeSummary(ready({}, null)).text, 'size unknown');
});

test('a worktree view combines names, branch, merge, size, changes, activity and sessions', () => {
  const view = worktreeView(row('r/feature-x', { path: '/home/u/work/feature-x/', branch: 'refs/heads/feat/x' }), '/repo', ready({ unstaged: 2, untracked: 3 }, 400 * MiB), { total: 2, active: 1 });
  assert.equal(view.name, 'feature-x', 'the directory basename, not the path');
  assert.equal(view.branch, 'feat/x');
  assert.equal(view.mergeText, 'NOT MERGED');
  assert.equal(view.size.text, 'size 400 MB');
  assert.equal(view.changes.text, '5 changes');
  assert.equal(view.activity?.text, 'idle · mtime-based');
  assert.deepEqual(view.sessions, { total: 2, active: 1 });
  assert.equal(view.attention, 3);
  const detached = worktreeView(row('r/d', { detached: true, branch: null, head: 'deadbeefcafe1234' }), '/repo', undefined, none);
  assert.equal(detached.branch, 'detached deadbeefcafe');
  const noPath = worktreeView(row('r/ghost', { class: 'missing', path: null, activity: null, integration: null }), '/repo', undefined, none);
  assert.equal(noPath.name, 'ghost');
  assert.equal(noPath.attention, 4);
  assert.equal(noPath.activity, null);
});

test('attention order: broken, unmerged with changes, unmerged, large or unknown, the rest; the main checkout closes the card', () => {
  const entries = new Map<string, FactsEntry>([
    ['r/broken', ready({ conflicts: 1 }, MiB)], ['r/work', ready({ unstaged: 1 }, MiB)], ['r/pushed', ready({}, 10 * MiB)], ['r/huge', ready({}, 5 * GiB)],
    ['r/unsure', ready({}, MiB)], ['r/dirty-merged', ready({ untracked: 1 }, MiB)], ['r/clean-a', ready({}, 8 * MiB)], ['r/clean-b', ready({}, 9 * MiB)], ['r/main', ready({ conflicts: 1 }, 99 * GiB)],
  ]);
  const rows = [
    row('r/clean-a', { integration: 'ancestor_merged' }), row('r/main', { class: 'main', integration: 'ancestor_merged' }), row('r/unsure', { integration: 'unknown' }), row('r/work'), row('r/pushed'),
    row('r/huge', { integration: 'ancestor_merged' }), row('r/broken', { integration: 'ancestor_merged' }), row('r/dirty-merged', { integration: 'ancestor_merged' }), row('r/clean-b', { integration: 'ancestor_merged' }),
    row('r/gone', { class: 'orphan_candidate', integration: null }),
  ];
  const project = projectViews([group('/repo', rows)], entries, () => none)[0]!;
  assert.deepEqual(project.worktrees.map(view => view.key), ['r/broken', 'r/gone', 'r/work', 'r/pushed', 'r/huge', 'r/dirty-merged', 'r/unsure', 'r/clean-b', 'r/clean-a', 'r/main']);
  assert.deepEqual(project.worktrees.map(view => view.attention), [4, 4, 3, 2, 1, 1, 1, 0, 0, 4], 'the main checkout is last even when it is in conflict; the card still ranks by its worst row');
  // Within one attention level the larger worktree comes first, then the name.
  assert.ok(compareWorktrees(project.worktrees[2]!, project.worktrees[3]!) < 0);
  const equal = (name: string) => worktreeView(row(`r/${name}`, { integration: 'ancestor_merged' }), '/repo', ready({}, MiB), none);
  assert.ok(compareWorktrees(equal('alpha'), equal('beta')) < 0);
  assert.equal(orderedWorktrees([project]).length, 10);
});

test('worktrees without facts yet sort by merge state alone and re-sort when facts arrive', () => {
  const rows = [row('r/a', { integration: 'unmerged' }), row('r/b', { integration: 'unmerged' })];
  const before = projectViews([group('/repo', rows)], new Map(), () => none)[0]!.worktrees.map(view => view.key);
  assert.deepEqual(before, ['r/a', 'r/b']);
  const after = projectViews([group('/repo', rows)], new Map([['r/b', ready({ unstaged: 2 }, MiB)]]), () => none)[0]!.worktrees.map(view => view.key);
  assert.deepEqual(after, ['r/b', 'r/a'], 'unmerged with uncommitted changes rises');
});

test('projects: attention first, then more unmerged, then name; an unreadable repository keeps its card and ranks above clean ones', () => {
  const main = (name: string, dir: string, extra: Partial<WorktreeRow> = {}) => row(`${name}/${name}`, { class: 'main', path: dir, repoCommonDir: `${dir}/.git`, integration: 'ancestor_merged', ...extra });
  const linked = (name: string, dir: string, integration: string) => row(`${name}/wt`, { path: `${dir}-wt`, repoCommonDir: `${dir}/.git`, integration });
  const groups = [
    group('/p/zeta', [main('zeta', '/p/zeta')]),
    group('/p/alpha', [main('alpha', '/p/alpha')]),
    group('/p/quota', [], { error: 'unavailable [source_error]: Source returned a structured read error.' }),
    group('/p/busy', [main('busy', '/p/busy'), linked('busy', '/p/busy', 'unmerged')]),
    group('/p/broken', [main('broken', '/p/broken'), row('broken/ghost', { class: 'missing', path: null, repoCommonDir: '/p/broken/.git', integration: null })]),
  ];
  const projects = projectViews(groups, new Map(), () => none);
  assert.deepEqual(projects.map(project => project.name), ['broken', 'busy', 'quota', 'alpha', 'zeta']);
  const quota = projects.find(project => project.name === 'quota')!;
  assert.equal(quota.error, 'unavailable [source_error]: Source returned a structured read error.');
  assert.equal(text(projectSummary(quota)), 'could not be read');
  assert.equal(quota.attention, 2);
});

test('rows listed without a repository filter are split by repository', () => {
  const rows = [row('a/main', { class: 'main', path: '/p/a', repoCommonDir: '/p/a/.git', integration: 'ancestor_merged' }), row('b/main', { class: 'main', path: '/p/b', repoCommonDir: '/p/b/.git', integration: 'ancestor_merged' }), row('a/wt', { path: '/p/a-wt', repoCommonDir: '/p/a/.git' })];
  const projects = projectViews([group(null, rows)], new Map(), () => none);
  assert.deepEqual(projects.map(project => [project.name, project.path, project.worktrees.length]), [['a', '/p/a', 2], ['b', '/p/b', 1]]);
  assert.equal(projects[0]!.repo, null);
  assert.equal(orderedWorktrees(projects).find(view => view.key === 'a/wt')!.repo, null, 'the inspect falls back to the worktree path');
});

test('project summary: counts, total size with lower bound, unmerged, all merged, unknown and changes', () => {
  const rows = [row('r/main', { class: 'main', integration: 'ancestor_merged', path: '/repo' }), row('r/a'), row('r/b', { integration: 'ancestor_merged' })];
  const entries = new Map<string, FactsEntry>([['r/main', ready({}, 600 * MiB)], ['r/a', ready({ unstaged: 1 }, Math.round(1.2 * GiB))], ['r/b', ready({}, GiB)]]);
  const project = projectViews([group('/repo', rows)], entries, () => none)[0]!;
  assert.equal(text(projectSummary(project)), '3 worktrees · 2.8 GB · 1 unmerged · 1 with changes');
  assert.equal(project.sizeLowerBound, false);
  // A worktree that is not measured yet turns the total into a lower bound.
  const partial = projectViews([group('/repo', rows)], new Map([['r/a', ready({}, GiB)]]), () => none)[0]!;
  assert.equal(partial.sizeLowerBound, true);
  assert.match(text(projectSummary(partial)), /^3 worktrees · ≥1\.0 GB · 1 unmerged$/);
  const fresh = projectViews([group('/repo', rows)], new Map(), () => none)[0]!;
  assert.match(text(projectSummary(fresh)), /^3 worktrees · size … · 1 unmerged$/);
  const merged = projectViews([group('/repo', [rows[0]!, rows[2]!])], new Map([['r/main', ready({}, MiB)], ['r/b', ready({}, MiB)]]), () => none)[0]!;
  assert.equal(text(projectSummary(merged)), '2 worktrees · 2.0 MB · all merged');
  const unknown = projectViews([group('/repo', [rows[0]!, row('r/u', { integration: null })])], new Map(), () => none)[0]!;
  assert.match(text(projectSummary(unknown)), /merge state unknown/);
  const single = projectViews([group('/repo', [rows[0]!])], new Map([['r/main', ready({}, MiB)]]), () => none)[0]!;
  assert.equal(text(projectSummary(single)), '1 worktree · 1.0 MB');
  const partialPage = projectViews([group('/repo', [rows[0]!], { partial: true })], new Map(), () => none)[0]!;
  assert.match(text(projectSummary(partialPage)), /partial$/);
});

test('a missing or unregistered folder is never measured and carries a plain note', () => {
  const rows = [row('r/main', { class: 'main', integration: 'ancestor_merged' }), row('r/ghost', { class: 'missing', path: '/gone', integration: null, activity: null }), row('r/orphan', { class: 'orphan_candidate', path: '/orph', integration: null, activity: null })];
  const project = projectViews([group('/repo', rows)], new Map([['r/ghost', ready({}, GiB)]]), () => none)[0]!;
  assert.equal(project.expected, 1);
  const ghost = project.worktrees.find(view => view.key === 'r/ghost')!;
  assert.equal(ghost.present, false);
  assert.equal(ghost.size.bytes, null, 'facts for a missing folder are ignored');
  const body = worktreeBody([project], 100, null).map(item => text(item.spans)).join('\n');
  assert.match(body, /folder is missing on disk/);
  assert.match(body, /folder without a Git registration/);
  assert.doesNotMatch(body.split('\n').filter(line => /ghost|orphan|folder/.test(line)).join('\n'), /size/);
  const removing = worktreeView(row('r/rm', { removalStarted: true }), '/repo', undefined, none);
  assert.equal(removing.note?.text, 'removal started');
});

test('tab summary totals the cards and reports measuring progress', () => {
  const rows = [row('r/main', { class: 'main', integration: 'ancestor_merged' }), row('r/a')];
  const projects = projectViews([group('/repo', rows)], new Map([['r/a', ready({}, 2 * GiB)]]), () => none);
  const summary = tabSummary(projects);
  assert.deepEqual(summary, { projects: 1, worktrees: 2, measured: 1, expected: 2, sizeBytes: 2 * GiB, sizeLowerBound: true });
  assert.equal(tabSummaryText(summary), '1 project · 2 worktrees · ≥2.0 GB on disk (1 of 2 measured)');
  assert.equal(tabSummaryText(tabSummary(projectViews([group('/repo', rows)], new Map(), () => none))), '1 project · 2 worktrees · sizes not measured yet');
  assert.equal(tabSummaryText({ projects: 0, worktrees: 0, measured: 0, expected: 0, sizeBytes: 0, sizeLowerBound: false }), '0 projects · 0 worktrees');
});

test('chips flow whole onto following rows and no row exceeds the width', () => {
  const chip = (value: string, glue = ' · ') => ({ spans: [{ text: value, tone: 'text' as const }], glue });
  const list = [chip('size 1.2 GB'), chip('5 changes'), chip('(3 modified · 1 staged · 1 new)', ' '), chip('idle · mtime-based'), chip('2 sessions (1 active)')];
  const wide = flowChips(list, 120, 4).map(text);
  assert.equal(wide.length, 1);
  assert.equal(wide[0], '    size 1.2 GB · 5 changes (3 modified · 1 staged · 1 new) · idle · mtime-based · 2 sessions (1 active)');
  for (const width of [90, 60, 40, 24]) {
    const rows = flowChips(list, width, 4).map(text);
    assert.ok(rows.every(line => stringWidth(line) <= width), `${width}: ${rows.join(' | ')}`);
    assert.ok(rows.every(line => line.startsWith('    ')));
    const words = (value: string) => value.replace(/[·]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
    if (width >= 40) assert.equal(words(rows.join(' ')), words(wide[0]!), 'no chip is lost or reordered');
  }
});

test('the body fits 140, 90 and 60 columns, marks the selected block and ties rows to keys', () => {
  const rows = [row('r/main', { class: 'main', path: '/home/user/projects/a-rather-long-project-name', integration: 'ancestor_merged', branch: 'refs/heads/work/long-diverged-local-branch' }), row('r/feature', { path: '/home/user/work/feature-with-a-long-name', branch: 'refs/heads/feature/a-very-long-branch-name-for-testing' })];
  const entries = new Map<string, FactsEntry>([['r/main', ready({ unstaged: 24, untracked: 9 }, 610 * MiB)], ['r/feature', ready({ staged: 1, unstaged: 3, untracked: 1 }, Math.round(1.5 * GiB))]]);
  const projects = projectViews([group('/home/user/projects/a-rather-long-project-name', rows)], entries, () => ({ total: 4, active: 1 }));
  for (const width of [140, 90, 60, 40]) {
    const body = worktreeBody(projects, width, 'r/feature');
    const lines = body.map(item => text(item.spans));
    assert.ok(lines.every(line => stringWidth(line) <= width), `${width}: a row is wider than the terminal`);
    const joined = lines.join('\n');
    assert.match(joined, /a-rather-long-project-name/);
    assert.match(joined, /\[NOT MERGED\]/);
    assert.match(joined, /\[MAIN\]/);
    assert.match(joined, /size 1\.5 GB/);
    assert.match(joined, /5 changes/);
    assert.match(joined, /4 sessions \(1 active\)/);
    assert.equal(lines.filter(line => line.includes('› ')).length, 1, 'exactly one selected marker');
    assert.ok(body.some(item => item.key === 'r/feature') && body.some(item => item.key === 'r/main'));
    assert.ok(body.filter(item => item.key === 'r/feature').length >= 3, 'the whole block belongs to the selection');
    assert.match(lines.find(line => line.includes('› '))!, /› feature-with-a-long-name|› feature-with/);
  }
  // The path keeps its tail (the project directory) when it must be clipped.
  const narrow = worktreeBody(projects, 40, null).map(item => text(item.spans)).join('\n');
  assert.match(narrow, /…[^\n]*long-project-name/);
});

test('technical lines keep the raw codes and failures that the plain words hide', () => {
  const rows = [row('r/main', { class: 'foreign', integration: 'ancestor_merged', activity: 'idle_candidate' })];
  const groups = [group('/repo', rows, { coverage: { repos: 1, root_unconfigured: true, failed: [] } }), group('/other', [], { error: 'unavailable [source_error]: x' })];
  const projects = projectViews(groups, new Map([['r/main', ready(null, 1234)]]), () => none);
  const lines = technicalLines(groups, projects, new Map([['r/main', ready(null, 1234)]])).map(line => line.text).join('\n');
  assert.match(lines, /r\/main class=foreign branch=refs\/heads\/main/);
  assert.match(lines, /integration=ancestor_merged activity=idle_candidate \(mtime_based\) size=1234 bytes status=unavailable\(probe_timeout\)/);
  assert.match(lines, /read error: unavailable \[source_error\]: x/);
  assert.match(lines, /Coverage \/repo: repos=1 root_unconfigured=true/);
  assert.match(technicalLines([], [], new Map()).join(''), /^$/);
});
