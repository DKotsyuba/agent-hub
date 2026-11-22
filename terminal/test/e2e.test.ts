/** Exercises the actual OpenTUI → native adapter → isolated source transports. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createNativeClient, observerPath } from './native-observer-harness.ts';
import { mountHub } from '../src/hub.ts';

const binary = process.env.AGENT_HUB_TEST_OBSERVER ?? observerPath();

test('live interface reads only the isolated Run and Bridge fixtures', async () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp && path.isAbsolute(temp));
  const directory = await mkdtemp(path.join(temp, 'hub-e2e-test-'));
  const socket = path.join(directory, 'run.sock'), helper = path.join(directory, 'bridge-fixture'), config = path.join(directory, 'connections.json');
  const methods: string[] = [], rawCursors: number[] = [];
  const observed = Math.floor(Date.now() / 1000);
  const server = net.createServer(connection => {
    let input = '';
    connection.on('data', chunk => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]!); methods.push(request.method);
      if (request.method === 'transcript' && request.params?.view === 'raw') rawCursors.push(request.params.cursor);
      const result = request.method === 'list_agents' ? { items: [{ agent_id: 'fixture-agent', sequence: 1, name: 'Live fixture task', task_summary: 'Inspect the isolated fixture.', status: 'running', model: 'fixture-model', workdir: '/fixture/project', elapsed_seconds: 12, silence_seconds: 2, observed_at: observed, last_progress_at: observed - 2, finished_at: null, answer_available: false, answer_sha256: null }], offset: 0, limit: 200, total: 1, next_offset: null, complete: true, revision: 1, message_revision: 1, observed_at: observed }
        : request.method === 'transcript' && request.params?.view === 'raw' ? { agent_id: 'fixture-agent', cursor: request.params.cursor, messages: [{ seq: 5, role: 'tool_result', name: 'Bash', raw_ref: 'fixture-call', content: 'last output', at: observed - 1, error: false, content_complete: true }], complete: true, next_cursor: null }
        : request.method === 'transcript' ? { agent_id: 'fixture-agent', view: 'blocks', cursor: 0, messages: [{ seq: 1, role: 'assistant', content: 'Live fixture transcript', at: observed, content_complete: true }, { seq: 2, first_seq: 2, last_seq: 2, role: 'tool_call', name: 'Bash', raw_ref: 'fixture-call', content: '{"command":"fixture command"}', at: observed - 10, content_complete: true }, { seq: 5, first_seq: 3, last_seq: 5, role: 'tool_result', name: 'Bash', raw_ref: 'fixture-call', content: 'fixture tool output', at: observed - 5, error: false, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 5 }
          : request.method === 'ping' ? { ok: true } : request.method === 'tools' ? [] : null;
      connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  await writeFile(helper, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);const counts={unhanded:0,reserved:0,invoking:0,held:0,review:0,accepted:0,hook_submitted:0,refused:0,disposed:0,open_incidents:0};const retention={events:0,payload_compacted:0,envelope_bytes:0,oldest_accepted_at_ms:null,newest_accepted_at_ms:null};const data=r.operation==='overview'?{counts,retention,coverage:'retained_history'}:{[r.operation]:[],through_seq:0,next_after_seq:null,coverage:'retained_history'};const kind=r.operation==='overview'?'bridge_overview':r.operation==='deliveries'?'delivery_page':'incident_page';process.stdout.write(JSON.stringify({schema_version:1,kind,data})+'\\n');});\n`, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper },
    quota: { socket: path.join(directory, 'quota.sock'), server_uid: process.getuid!() },
    pool: { socket: path.join(directory, 'pool.sock'), server_uid: process.getuid!() },
    worktree: { program: path.join(directory, 'worktree-disabled') } }));
  const previous = process.env.AGENT_HUB_CONFIG;
  process.env.AGENT_HUB_CONFIG = config;
  const client = createNativeClient(binary), setup = await createTestRenderer({ width: 120, height: 40 });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    /** Lets real child-process I/O run between bounded frame checks. */
    async function waitForFrame(predicate: (frame: string) => boolean): Promise<string> {
      for (let attempt = 0; attempt < 200; attempt++) {
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        if (predicate(frame)) return frame;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for fixture-backed terminal frame');
    }
    const overview = await waitForFrame(value => value.includes('1 loaded') && value.includes('Retained by Bridge'));
    assert.match(overview, /LIVE READ-ONLY/);
    setup.mockInput.pressKey('1');
    await waitForFrame(value => value.includes('Live fixture task') && value.includes('Live fixture transcript') && value.includes('fixture command') && value.includes('· 9s'));
    assert.deepEqual(rawCursors, [4], 'the final result timestamp comes through the actual observer transport');
    assert.ok(methods.includes('list_agents') && methods.includes('transcript'));
    assert.ok(methods.every(method => ['list_agents', 'transcript', 'ping', 'tools', 'capabilities'].includes(method)), 'UI emitted only expected source reads');
    assert.ok(methods.includes('ping') && methods.includes('tools'), 'opening a session checks the optional initial_task capability through finite identity discovery');
    assert.ok(!methods.includes('initial_task') && !methods.includes('capabilities'), 'a Run that does not advertise the method is never asked for it or its flag');
  } finally {
    unmount(); await client.close(); await setup.dispose();
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
