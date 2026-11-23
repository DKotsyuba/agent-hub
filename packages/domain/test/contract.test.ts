/** Contract checks for route normalization and evidence-bearing decoders. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { API_PREFIX, API_RESPONSES, API_ROUTES, apiError, event, initialTask, parseApiRequest } from '../src/index.ts';

/** Resolves relative test inputs without using a network transport. */
function request(fragment: string) {
  return parseApiRequest(new URL(API_PREFIX + fragment, 'http://hub.test'));
}

test('v1 route map has one response decoder for every non-stream route', () => {
  assert.deepEqual(Object.keys(API_ROUTES).filter(key => key !== 'events'), Object.keys(API_RESPONSES));
  assert.equal(request('/pools/one/edit'), null);
  assert.deepEqual(request('/sessions?limit=999&status=failed&q=%20demo%20&from=0&to=1'), {
    route: 'sessions', limit: 200, status: 'failed', q: 'demo', project: null, from: 0, to: 1, cursor: null,
  });
  assert.deepEqual(request('/worktrees'), { route: 'worktrees', limit: 20, project: null, cursor: null });
  assert.deepEqual(request('/pools/one/history'), {
    route: 'poolHistory', id: 'one', limit: 50, edge: null, direction: null, cursor: null,
  });
});

test('invalid filters, IDs, cursors and topic combinations fail closed', () => {
  for (const input of [
    '/worktrees?limit=0', '/sessions?limit=1&limit=1', '/overview?from=10&to=10',
    '/pools?state=unknown', '/sessions/%2Fetc%2Fpasswd', '/worktrees/one?repo=/elsewhere',
    '/pools/one/sections/history', '/pools/one/sections/members?proposal=p',
    '/pools/one/content/purpose?proposal=p', '/pools?cursor=%20',
    '/bridge/incidents?includeClosed=1', '/events', '/events?topic=pool:one:unknown',
    '/events?topic=pool:one:history&topic=pool:two:history', '/events?topic=quota&interval=4',
  ]) assert.throws(() => request(input), Error, input);
  assert.deepEqual(request('/events?topic=pools&topic=pool:one:history&topic=pool:one:detail&interval=5'), {
    route: 'events', topics: ['pools', 'pool:one:history', 'pool:one:detail'], interval: 5,
  });
});

test('decoders allow additive fields and reject invalid evidence and page fields', () => {
  assert.deepEqual(API_RESPONSES.health({
    ready: true, apiVersion: 1, release: '0.1.3', mode: 'fixture', additional: true,
  }), { ready: true, apiVersion: 1, release: '0.1.3', mode: 'fixture' });
  assert.throws(() => API_RESPONSES.sessions({ data: { items: [] }, observations: [] }), /page/);
  assert.throws(() => event({ type: 'changed', topic: 'mutation', boundary: null }), /topic/);
  assert.throws(() => initialTask({
    state: 'verified', content: { text: '', offsetBytes: 0, totalBytes: 0 },
    proof: { kind: 'strict', root: { sequence: 1, execution: 'opaque', sha256: '0'.repeat(64) }, storeFenced: true, activePin: false },
  }), /activePin/);
  assert.throws(() => apiError({ error: { code: 'not_found', message: 'Missing', retryable: 'no', requestId: 'req-1' } }), /retryable/);
});

test('pool queries support lifecycle and legacy closure filters', () => {
  for (const state of ['live', 'finished', 'open', 'closed', 'all']) {
    const query = request('/pools?state=' + state);
    assert.equal(query?.route === 'pools' && query.state, state);
  }
});
