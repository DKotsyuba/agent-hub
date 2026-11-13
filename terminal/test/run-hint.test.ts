/** Run access failures carry an actionable socket/group hint; other failures do not. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAccessHint } from '../src/hub.ts';

test('run access codes add the socket and agent-run group hint', () => {
  for (const code of ['run_endpoint', 'run_endpoint_identity', 'run_endpoint_parent', 'run_connect', 'run_peer_identity']) {
    assert.match(runAccessHint(code), /agent-run group/);
    assert.match(runAccessHint(code), /socket/);
  }
  for (const code of [undefined, 'run_source_error', 'client_timeout', 'cancelled']) assert.equal(runAccessHint(code), '');
});
