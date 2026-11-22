/** Exercises every v1 response over the fixture-only fetch seam. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { API_PREFIX, API_RESPONSES, type ApiResponse, apiError, event } from '../../domain/src/index.ts';
import { SCENARIOS, createFixtureFetch, type FixtureScenario } from '../fixtures/index.ts';

const baseUrl = `http://hub.test${API_PREFIX}`;

/** Issues a synthetic GET and typechecks the decoded response against its route. */
async function get<K extends keyof typeof API_RESPONSES>(
  fetcher: typeof fetch,
  route: K,
  path: string,
): Promise<ApiResponse<K>> {
  const response = await fetcher(baseUrl + path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return API_RESPONSES[route](await response.json()) as ApiResponse<K>;
}

test('every scenario decodes and exposes independent source outcomes', async () => {
  for (const scenario of Object.keys(SCENARIOS) as FixtureScenario[]) {
    const fetcher = createFixtureFetch(scenario);
    assert.equal((await get(fetcher, 'health', '/health')).mode, 'fixture');
    if (scenario === 'incompatible' || scenario === 'unavailable') {
      for (const path of ['/overview', '/sessions', '/pools', '/quota', '/worktrees', '/bridge/incidents']) {
        const response = await fetcher(baseUrl + path);
        assert.equal(response.status, scenario === 'incompatible' ? 422 : 503);
        assert.equal(apiError(await response.json()).error.code, scenario === 'incompatible' ? 'unsupported_capability' : 'source_unavailable');
      }
      continue;
    }
    const overview = await get(fetcher, 'overview', '/overview');
    const inventory = await get(fetcher, 'sessions', '/sessions');
    const pools = await get(fetcher, 'pools', '/pools');
    const quota = await get(fetcher, 'quota', '/quota');
    const worktrees = await get(fetcher, 'worktrees', '/worktrees');
    if (scenario === 'empty') {
      assert.equal(inventory.observations[0].outcome, 'ok');
      assert.equal(overview.data.run?.finished.value, 0);
      assert.deepEqual([inventory.data.items, pools.data.items, quota.data.snapshot?.accounts, worktrees.data.items], [[], [], [], []]);
      assert.deepEqual((await get(fetcher, 'incidents', '/bridge/incidents')).data.items, []);
    } else if (scenario === 'partial-stale') {
      assert.ok(overview.observations.some(item => item.source === 'bridge' && item.outcome === 'unavailable'));
      assert.ok(inventory.observations[0].staleSinceMs! > inventory.observations[0].observedAtMs);
      assert.equal(quota.data.snapshot?.accounts[0].models[0].remaining, null);
      assert.equal(worktrees.data.items[1].facts.size.state, 'unavailable');
      assert.equal((await get(fetcher, 'sessionHistory', '/sessions/demo-inspect/history')).data.format, 'legacy_raw');
      assert.equal((await get(fetcher, 'poolHistory', '/pools/pool-managed-1/history')).data.format, 'legacy_forward');
      assert.equal((await fetcher(baseUrl + '/pools/pool-managed-1/history?edge=tail')).status, 422);
      assert.equal((await fetcher(baseUrl + '/sessions/demo-inspect/result')).status, 422);
      assert.equal((await fetcher(baseUrl + '/sessions/demo-inspect/export')).status, 404);
      assert.equal((await fetcher(baseUrl + '/bridge/incidents')).status, 503);
    }
  }
});

test('populated details preserve independent proofs and sections', async () => {
  const fetcher = createFixtureFetch('populated');
  const session = await get(fetcher, 'session', '/sessions/demo-historical?execution=exec-old');
  assert.equal(session.data.lineage?.selected?.rawStatus, 'succeeded');
  assert.equal(session.data.lineage?.retainedLatest?.rawStatus, 'running');
  assert.equal(session.data.answerAttribution, 'unverified');
  const transcript = await get(fetcher, 'sessionHistory', '/sessions/demo-finished/history');
  assert.equal(transcript.data.entries[2].calls[0].sourceRef, transcript.data.entries[2].results[0].sourceRef);
  assert.equal(transcript.data.entries[3].head.role, 'tool_result');
  const strict = await get(fetcher, 'initialTask', '/sessions/demo-historical/initial-task?execution=exec-old');
  assert.ok(strict.data.state === 'verified' && strict.data.proof.kind === 'strict');
  const current = await get(fetcher, 'initialTask', '/sessions/demo-inspect/initial-task');
  assert.ok(current.data.state === 'verified' && current.data.proof.kind === 'current');
  const unverified = await get(fetcher, 'initialTask', '/sessions/demo-failed/initial-task');
  assert.equal(unverified.data.state, 'unverified');
  const retained = await get(fetcher, 'sessionExport', '/sessions/demo-finished/export?mode=retained');
  assert.ok(retained.data.mode === 'retained' && retained.data.coverage.state === 'partial');
  const exact = await get(fetcher, 'sessionExport', '/sessions/demo-historical/export?execution=exec-old&mode=exact');
  assert.ok(exact.data.mode === 'exact' && exact.data.proof.activePin);
  const pool = await get(fetcher, 'pool', '/pools/pool-chat-1');
  assert.equal(pool.data.pool.record?.kind, 'agreement');
  const poolList = await get(fetcher, 'pools', '/pools');
  assert.equal(poolList.data.totals?.completed, null);
  for (const section of ['members', 'proposals', 'decisions', 'criteria', 'votes', 'deliveries'] as const) {
    const id = section === 'deliveries' ? 'pool-managed-1' : 'pool-chat-1';
    const { data } = await get(fetcher, 'poolSection', `/pools/${id}/sections/${section}`);
    assert.equal(data.section, section);
    assert.ok(data.items.length > 0);
  }
  const history = await get(fetcher, 'poolHistory', '/pools/pool-chat-1/history');
  assert.equal(history.data.items[1].parts.length, 2);
  assert.ok(history.data.upperBound);
  assert.equal((await get(fetcher, 'poolContent', '/pools/pool-chat-1/content/purpose')).data.field, 'purpose');
  assert.equal((await get(fetcher, 'poolContent', '/pools/pool-chat-1/content/snapshot?proposal=prop-3')).data.proposalId, 'prop-3');
  const agreement = await get(fetcher, 'poolRecord', '/pools/pool-chat-1/records/agr-7');
  assert.ok(agreement.data.kind === 'agreement' && agreement.data.ballots.length === 2);
  const completion = await get(fetcher, 'poolRecord', '/pools/pool-managed-1/records/completion-demo');
  assert.ok(completion.data.kind === 'completion' && completion.data.content[0].sha256);
  const worktree = await get(fetcher, 'worktree', '/worktrees/wt-review');
  assert.ok(worktree.data.worktree.facts.size.state === 'known' && worktree.data.worktree.facts.size.lowerBound);
  assert.equal(worktree.data.worktree.sessions[0].sessionId, 'demo-finished');
  assert.equal((await get(fetcher, 'incidents', '/bridge/incidents?includeClosed=true')).data.items.length, 2);
});

test('result pages assemble under one execution fence and digest', async () => {
  const fetcher = createFixtureFetch('populated');
  const path = '/sessions/demo-finished/result?execution=exec-finished';
  const first = await get(fetcher, 'sessionResult', path);
  const next = first.page.next;
  assert.ok(next);
  const second = await get(fetcher, 'sessionResult', `${path}&cursor=${next}`);
  assert.deepEqual(first.data.proof, second.data.proof);
  assert.equal(first.data.content.offsetBytes, 0);
  assert.equal(second.data.content.offsetBytes, Buffer.byteLength(first.data.content.text));
  const text = first.data.content.text + second.data.content.text;
  assert.equal(Buffer.byteLength(text), first.data.content.totalBytes);
  assert.equal(createHash('sha256').update(text).digest('hex'), first.data.proof.sha256);
  assert.equal(second.page.next, null);
  assert.equal((await fetcher(baseUrl + '/sessions/demo-finished/result?execution=wrong')).status, 409);
  assert.equal((await fetcher(baseUrl + '/sessions/demo-inspect/result')).status, 404);
});

test('history keeps the older anchor and live resume independent', async () => {
  const fetcher = createFixtureFetch('populated');
  const history = '/pools/pool-chat-1/history?edge=tail&limit=3';
  const tail = await get(fetcher, 'poolHistory', history);
  assert.equal(tail.data.items[0].position, '2');
  assert.ok(tail.page.previous && tail.page.resume);
  assert.notEqual(tail.page.previous, tail.page.resume);
  const older = await get(fetcher, 'poolHistory', `${history}&direction=older&cursor=${tail.page.previous}`);
  assert.deepEqual(older.data.items.map(row => row.position), ['1']);
  assert.equal(older.data.upperBound, tail.data.upperBound);
  const resumed = await get(fetcher, 'poolHistory', `${history}&direction=newer&cursor=${tail.page.resume}`);
  assert.deepEqual(resumed.data.items, []);
  assert.equal(resumed.page.resume, tail.page.resume);
  assert.equal((await fetcher(baseUrl + `${history}&direction=newer&cursor=${tail.page.previous}`)).status, 400);
});

test('list cursors bind normalized filters and the scenario', async () => {
  const fetcher = createFixtureFetch('populated');
  const path = '/sessions?status=finished&limit=1';
  const first = await get(fetcher, 'sessions', path);
  const next = first.page.next;
  assert.ok(next);
  const second = await get(fetcher, 'sessions', `${path}&cursor=${next}`);
  assert.notEqual(first.data.items[0].id, second.data.items[0].id);
  assert.equal((await fetcher(baseUrl + `${path}&q=failed&cursor=${next}`)).status, 400);
  assert.equal((await createFixtureFetch('empty')(baseUrl + `${path}&cursor=${next}`)).status, 409);
  assert.equal((await fetcher(baseUrl + '/pools/chat/replies', { method: 'POST' })).status, 405);
  assert.equal((await fetcher(baseUrl + '/pools', { headers: { Origin: 'https://another.test' } })).status, 400);
});

test('fixture SSE emits named messages and can be cancelled and reopened', async () => {
  const fetcher = createFixtureFetch('partial-stale');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetcher(baseUrl + '/events?topic=incidents&interval=1');
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
    const reader = response.body!.getReader();
    try {
      for (const type of ['ready', 'source-state', 'changed']) {
        const { value } = await reader.read();
        const [name, data] = new TextDecoder().decode(value).split('\n');
        assert.equal(name, `event: ${type}`);
        const message = event(JSON.parse(data.substring(6)));
        assert.equal(message.type, type);
        if (message.type === 'source-state') assert.equal(message.observation.outcome, 'unavailable');
      }
    } finally {
      await reader.cancel();
    }
  }
});
