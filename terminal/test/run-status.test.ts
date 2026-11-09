/** Exercises the status v1 boundary using synthetic responses captured from Run. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseRunStatus, runStatusRequest, validRunAgentId } from '../src/run-status.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

interface FixtureCase { request: RunStatusRequest; result?: Record<string, unknown>; error?: { data?: { code?: string } } }
interface MutableStatus {
  version: number;
  store_id: string;
  items: {
    selector: { agent_id: string; sequence: number; execution_ref?: string };
    pin_id: string | null;
    match: string;
    selected: { sequence: number; execution_ref: string | null; raw_status: string };
    retained_latest: { sequence: number; execution_ref: string | null; raw_status: string };
    lineage_terminal: boolean | null;
    terminal_outcome: string | null;
    cleanup: { state: string };
    success_commit: string;
    pin_state: string;
  }[];
  view: { selector_index: number; match: string; status_scope: string; sampled_at: number; agent: { agent_id: string; sequence: number; status: string } };
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/run-status-v1.json', import.meta.url), 'utf8')) as { cases: Record<string, FixtureCase> };

/** Returns an independent synthetic case so one mutation cannot affect another. */
function example(name: string): FixtureCase {
  const value = fixture.cases[name];
  assert.ok(value, `missing synthetic case: ${name}`);
  return structuredClone(value);
}

/** Checks the fixture shape before applying controlled negative mutations. */
function editable(value: unknown): asserts value is MutableStatus {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  assert.equal(typeof row.version, 'number');
  assert.equal(typeof row.store_id, 'string');
  assert.ok(Array.isArray(row.items) && row.items.length === 1 && row.view && typeof row.view === 'object');
}

test('Run status accepts the verified, unverified and absent source examples', () => {
  for (const [name, expected] of [['verified_selected_not_tail', 'verified'], ['unverified', 'unverified'], ['mismatch', 'mismatch'], ['missing', 'missing']] as const) {
    const item = example(name), result = parseRunStatus(item.result, item.request);
    assert.equal(result.match, expected);
    if (expected === 'verified' || expected === 'unverified') {
      assert.equal(result.selected?.sequence, 1);
      assert.equal(result.retainedLatest?.sequence, 2);
      assert.equal(result.view?.agent.sequence, 1);
      assert.equal(result.lineageTerminal, expected === 'verified' ? false : null);
      assert.equal(result.terminalOutcome, null);
      assert.equal((result.view?.agent.raw.delivery as { ambiguous: boolean }).ambiguous, true);
    } else {
      assert.equal(result.selected, null);
      assert.equal(result.view, null);
    }
  }
  assert.equal(example('store_identity_mismatch').error?.data?.code, 'StoreIdentityMismatch');
});

test('a pending restart is not promoted to success by a raw terminal view or answer', () => {
  const item = example('restart_pending_raw_terminal'), result = parseRunStatus(item.result, item.request);
  assert.equal(result.view?.agent.status, 'succeeded');
  assert.equal(result.view?.agent.answerAvailable, true);
  assert.equal(result.restartResume, 'pending');
  assert.equal(result.lineageTerminal, false);
  assert.equal(result.terminalOutcome, null);
  assert.equal(result.cleanup, 'pending');
  assert.equal(result.storeFenced, false);
});

test('confirmed lineage outcome remains attached to the retained latest execution', () => {
  const item = example('verified_selected_not_tail');
  assert.ok(item.result);
  editable(item.result);
  const source = item.result.items[0];
  source.retained_latest.raw_status = 'succeeded';
  source.lineage_terminal = true;
  source.terminal_outcome = 'succeeded';
  source.success_commit = 'recorded';
  source.cleanup.state = 'confirmed';
  const result = parseRunStatus(item.result, item.request);
  assert.equal(result.selected?.sequence, 1);
  assert.equal(result.retainedLatest?.sequence, 2);
  assert.equal(result.lineageTerminal, true);
  assert.equal(result.terminalOutcome, 'succeeded');
  assert.equal(result.cleanup, 'confirmed');
  assert.equal(result.storeFenced, true);
});

test('a Pool binding becomes an exact selector without silently dropping malformed identities', () => {
  const item = example('verified_selected_not_tail'), target = item.request.targets[0];
  const binding = { run_id: target.agent_id, run_sequence: target.sequence, run_execution_ref: target.execution_ref, run_pin_id: target.pin_id, run_store_id: item.request.expected_store_id };
  assert.deepEqual(runStatusRequest(binding), item.request);
  assert.deepEqual(runStatusRequest({ run_id: target.agent_id, run_sequence: 1 }), { version: 1, targets: [{ agent_id: target.agent_id, sequence: 1 }], include_view: true });
  for (const [field, invalid] of [['run_execution_ref', 'ex1_bad'], ['run_pin_id', 'pin_bad'], ['run_store_id', 'store_bad'], ['run_sequence', 0], ['run_id', '']] as const) {
    assert.throws(() => runStatusRequest({ ...binding, [field]: invalid }), field);
  }
  for (const field of ['run_execution_ref', 'run_pin_id', 'run_store_id'] as const) {
    assert.throws(() => runStatusRequest({ ...binding, [field]: `${binding[field]}\n` }), `${field} cannot end in a line terminator`);
  }
});

test('Run IDs use the source calendar grammar, including whitespace and leap seconds', () => {
  const valid = ['ag-20261106-200060-0000000001', 'ag-20261106-2 0000-0000000001', 'ag-20240229-235959-abcdef0123'];
  const invalid = ['invalid-agent', 'ag-20260230-010101-0000000001', 'ag-20261106-250000-0000000001', 'ag-20261106-200000-ABCDEF0123', 'ag-20261106-200061-0000000001', 'ag-20261106-200000-0000000001\n', 'ag-20261106-2\u00a00000-0000000001'];
  for (const id of valid) assert.equal(validRunAgentId(id), true, id);
  for (const id of invalid) {
    assert.equal(validRunAgentId(id), false, id);
    assert.throws(() => runStatusRequest({ run_id: id, run_sequence: 1 }), id);
  }
  const item = example('verified_selected_not_tail');
  assert.ok(item.result);
  const output = item.result as { items: { canonical_agent_id: string }[] };
  output.items[0].canonical_agent_id = 'invalid-agent';
  assert.throws(() => parseRunStatus(output, item.request), 'an invalid canonical identity cannot attest an execution');
});

test('unknown execution identity cannot expose a retained latest execution', () => {
  const item = example('mismatch');
  assert.ok(item.result);
  const output = item.result as { items: Record<string, unknown>[] };
  output.items[0].match = 'unknown';
  output.items[0].selected = { sequence: item.request.targets[0].sequence, execution_ref: null, raw_status: 'running' };
  output.items[0].retained_latest = { sequence: item.request.targets[0].sequence, execution_ref: null, raw_status: 'running' };
  assert.throws(() => parseRunStatus(output, item.request));
});

test('status evidence rejects wrong store, selector, view and unsupported version', () => {
  const mutations: [string, (value: MutableStatus) => void][] = [
    ['version', value => { value.version = 2; }],
    ['store', value => { value.store_id = `store_${'f'.repeat(32)}`; }],
    ['extra item', value => { value.items.push(structuredClone(value.items[0])); }],
    ['agent selector', value => { value.items[0].selector.agent_id = 'another-agent'; }],
    ['sequence selector', value => { value.items[0].selector.sequence = 2; }],
    ['execution selector', value => { value.items[0].selector.execution_ref = `ex1_${'f'.repeat(64)}`; }],
    ['pin selector', value => { value.items[0].pin_id = null; }],
    ['view index', value => { value.view.selector_index = 1; }],
    ['view match', value => { value.view.match = 'unverified'; }],
    ['view scope', value => { value.view.status_scope = 'lineage'; }],
    ['view agent', value => { value.view.agent.agent_id = 'another-agent'; }],
    ['view sequence', value => { value.view.agent.sequence = 2; }],
    ['view status', value => { value.view.agent.status = 'running'; }],
    ['view clock', value => { value.view.sampled_at += 1; }],
    ['invalid latest sequence', value => { value.items[0].retained_latest.sequence = 0; }],
    ['same sequence with different identity', value => { value.items[0].retained_latest.sequence = 1; }],
  ];
  for (const [label, mutate] of mutations) {
    const item = example('verified_selected_not_tail');
    assert.ok(item.result);
    editable(item.result);
    mutate(item.result);
    assert.throws(() => parseRunStatus(item.result, item.request), label);
  }
  const earlier = example('verified_selected_not_tail');
  assert.ok(earlier.result);
  const output = earlier.result;
  editable(output);
  earlier.request.targets[0].sequence = 2;
  output.items[0].selector.sequence = 2;
  output.items[0].selected.sequence = 2;
  output.view.agent.sequence = 2;
  output.items[0].retained_latest.sequence = 1;
  assert.throws(() => parseRunStatus(output, earlier.request), 'latest precedes selected');
});

test('status evidence rejects forged success, cleanup or execution verification', () => {
  const mutations: [string, (value: MutableStatus) => void][] = [
    ['terminal while running', value => { value.items[0].lineage_terminal = true; value.items[0].terminal_outcome = 'succeeded'; }],
    ['cleanup without terminal', value => { value.items[0].cleanup.state = 'confirmed'; }],
    ['success without terminal', value => { value.items[0].success_commit = 'recorded'; }],
    ['incomplete pin coverage', value => { value.items[0].pin_state = 'released'; }],
    ['unverified ref', value => { value.items[0].selected.execution_ref = `ex1_${'f'.repeat(64)}`; }],
    ['verified without canonical root', value => { (value.items[0] as { canonical_agent_id?: string | null }).canonical_agent_id = null; }],
    ['false terminality without proof', value => { value.items[0].pin_state = 'released'; (value.items[0] as { coverage?: string }).coverage = 'unknown'; }],
  ];
  for (const [label, mutate] of mutations) {
    const item = example('verified_selected_not_tail');
    assert.ok(item.result);
    editable(item.result);
    mutate(item.result);
    assert.throws(() => parseRunStatus(item.result, item.request), label);
  }
  const item = example('unverified');
  assert.ok(item.result);
  const output = item.result as { items: { match: string }[] };
  output.items[0].match = 'verified';
  assert.throws(() => parseRunStatus(output, item.request));
  const noRef = example('unverified');
  assert.ok(noRef.result);
  editable(noRef.result);
  noRef.result.items[0].selected.execution_ref = null;
  assert.throws(() => parseRunStatus(noRef.result, noRef.request), 'complete coverage cannot omit the selected execution ref');
  const noTailRef = example('unverified');
  assert.ok(noTailRef.result);
  editable(noTailRef.result);
  noTailRef.result.items[0].retained_latest.execution_ref = null;
  assert.throws(() => parseRunStatus(noTailRef.result, noTailRef.request), 'complete coverage cannot omit the latest execution ref');
});
