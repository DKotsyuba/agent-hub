/** Quota tab and Overview card render synthetic Quota observations read-only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

test('overview shows a quota card and the Quota tab lists every account and model', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    let frame = await setup.waitForFrame(value => value.includes('Agent Quota') && value.includes('Known 2'));
    assert.match(frame, /Known 2 · Unknown 1 · Exhausted 0/);
    assert.match(frame, /Lowest known: demo-account\/model-alpha 72%/);
    const rows = frame.split('\n');
    assert.ok(rows.findIndex(row => row.includes('Agent Quota')) > rows.findIndex(row => row.includes('Agent Bridge')));
    assert.ok(rows.findIndex(row => row.includes('Needs attention')) > rows.findIndex(row => row.includes('Agent Quota')));
    setup.mockInput.pressKey('4');
    frame = await setup.waitForFrame(value => value.includes('Account demo-unknown') && value.includes('Service: running'));
    assert.match(frame, /\[Quota\]/);
    assert.match(frame, /demo\/model-gamma · UNKNOWN/);
    assert.match(frame, /remaining Unknown · burn Unknown · reset Unknown/);
    assert.match(frame, /demo\/model-alpha · KNOWN · risk low/);
    assert.match(frame, /remaining 72% · burn 2\.5 pp\/h/);
    assert.match(frame, /coverage partial/);
    setup.mockInput.pressKey('END');
    frame = await setup.waitForFrame(value => value.includes('treat limits as unverified'));
    assert.match(frame, /never zero/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
