/** Worktree page/detail parsing and workdir-based session linking. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { detailLines, linkedSessions, repositoriesData, worktreeDetail, worktreeFor, worktreePage } from '../src/worktree.ts';

const row = (key: string, path: string | null, kind = 'foreign') => ({ key, class: kind, path, branch: 'refs/heads/x', detached: false, head: 'h', repo_id: 'r', repo_common_dir: '/r/.git', creator: null, removal_started: false, activity: null, integration: null, size: null });

test('pages validate their envelope and keep unprobed values null', () => {
  const page = worktreePage({ schema_version: 1, kind: 'worktree_page', data: { rows: [row('a', '/r'), row('b', null, 'missing')], has_more: true, cursor: 'c1', hygiene: {}, coverage: { repos: 1 } } });
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0]!.activity, null);
  assert.equal(page.rows[1]!.path, null);
  assert.equal(page.cursor, 'c1');
  assert.throws(() => worktreePage({ schema_version: 1, kind: 'worktree_detail', data: { rows: [], has_more: false } }));
  assert.throws(() => worktreePage({ schema_version: 1, kind: 'worktree_page', error: { code: 'not_a_repository' } }));
  assert.throws(() => repositoriesData({ repositories: ['relative'] }));
  assert.deepEqual(repositoriesData({ repositories: ['/a'] }), ['/a']);
});

test('sessions link to the most specific worktree containing their workdir', () => {
  const rows = worktreePage({ schema_version: 1, kind: 'worktree_page', data: { rows: [row('main', '/r', 'main'), row('nested', '/r/.worktrees/x'), row('other', '/r2')], has_more: false, cursor: null } }).rows;
  const agents = [{ id: '1', workdir: '/r/src' }, { id: '2', workdir: '/r/.worktrees/x' }, { id: '3', workdir: '/r/.worktrees/x/deep' }, { id: '4', workdir: '/r2x' }, { id: '5', workdir: null }];
  assert.deepEqual(linkedSessions(rows[0]!, rows, agents).map(agent => agent.id), ['1']);
  assert.deepEqual(linkedSessions(rows[1]!, rows, agents).map(agent => agent.id), ['2', '3']);
  assert.deepEqual(linkedSessions(rows[2]!, rows, agents).map(agent => agent.id), []);
  assert.equal(worktreeFor('/r2x', rows), null);
});

test('detail lines keep degraded probes degraded', () => {
  const detail = worktreeDetail({ schema_version: 1, kind: 'worktree_detail', data: { key: 'k', class: 'managed', path: '/r', probes: { status: { state: 'known', value: { staged: 1 } }, processes: { state: 'unavailable', code: 'probe_timeout' }, size: { state: 'not_checked' }, integration: { state: 'incomplete', value: 'unmerged', reason: 'budget' } }, warnings: [{ code: 'unmerged' }], record: null } });
  const text = detailLines(detail, 1000).join('\n');
  assert.match(text, /Status: staged=1/);
  assert.match(text, /Processes: unavailable \(probe_timeout\)/);
  assert.match(text, /Size: not checked/);
  assert.match(text, /Integration: unmerged \(incomplete: budget\)/);
  assert.match(text, /Submodules: Unknown/);
  assert.match(text, /Warnings: unmerged/);
});
