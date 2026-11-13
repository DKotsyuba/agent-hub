/** Worktree tab lists configured repositories, opens a detail and links Run sessions. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

test('worktree list, detail and session link', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    await setup.waitForFrame(value => value.includes('Needs attention'));
    setup.mockInput.pressKey('5');
    let frame = await setup.waitForFrame(value => value.includes('Repository: /demo/agent-hub') && value.includes('demo/workspace') && /sessions 2 \(1 active\)/.test(value));
    assert.match(frame, /\[Worktree\]/);
    assert.match(frame, /1 configured repositories/);
    assert.match(frame, /managed\s+feature\/demo\s+idle_candidate~/);
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('Processes: unavailable (probe_timeout)') && value.includes('Run sessions in this worktree (2)'));
    assert.match(frame, /Agent Worktree · demo\/workspace/);
    assert.match(frame, /Index repository/);
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('[Sessions]'));
    setup.mockInput.pressKey('5');
    frame = await setup.waitForFrame(value => value.includes('Agent Worktree · demo/workspace'));
    setup.mockInput.pressEscape();
    await setup.waitForFrame(value => value.includes('Repository: /demo/agent-hub'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
