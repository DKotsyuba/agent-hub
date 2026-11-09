/** Tests the explicit old-broker fallback without interpreting unrelated failures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

for (const unsupported of [true, false]) {
  test(`raw transcript fallback ${unsupported ? 'uses' : 'does not guess from'} the explicit compatibility error`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient(), requests: Record<string, unknown>[] = [];
    const client: ObservationClient = {
      async read(resource, params = {}, signal) {
        if (resource !== 'run.transcript') return demo.read(resource, params, signal);
        requests.push({ ...params });
        if (params.view === 'blocks') return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: unsupported ? 'incompatible' : 'unavailable', data: null, error: { code: unsupported ? 'run_blocks_unsupported' : 'run_source_error', message: 'Source unavailable' } };
        const cursor = Number(params.cursor ?? 0), all = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1, role: index === 0 ? 'user' : 'assistant', name: null, content: index === 0 ? 'Legacy initial prompt' : `Legacy row ${index + 1}`, at: 100 + index, content_complete: true }));
        const messages = all.filter(row => row.seq > cursor).slice(0, 2), last = messages.at(-1)?.seq ?? cursor, complete = last >= all.length;
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: complete ? 'ok' : 'partial', error: null, data: { agent_id: params.agent_id, cursor, limit: params.limit, messages, complete, next_cursor: complete ? null : last } };
      },
      close: () => demo.close(),
    };
    const unmount = mountHub(setup.renderer, client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1');
      if (unsupported) {
        await setup.waitForFrame(value => value.includes('Legacy initial prompt') && value.includes('Legacy row 4'));
        assert.ok(requests.some(request => request.view === undefined && request.cursor === 0));
        setup.mockInput.pressKey('G');
        await setup.waitForFrame(value => value.includes('Legacy row 6') && value.includes('Following'));
      } else {
        await setup.waitForFrame(value => value.includes('Beginning unavailable'));
        assert.ok(requests.length > 0 && requests.every(request => request.view === 'blocks'));
      }
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('a broker that silently returns raw data cannot make a blocks request appear complete', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'raw', cursor: params.cursor ?? 0, messages: [{ seq: 1, role: 'user', name: null, content: 'Unproven raw data', at: 100, content_complete: true }], complete: true, next_cursor: null } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); await setup.waitForFrame(value => value.includes('Beginning unavailable'));
    setup.mockInput.pressKey('G');
    const frame = await setup.waitForFrame(value => value.includes('invalid'));
    assert.doesNotMatch(frame, /Unproven raw data|loaded history complete/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
