/** Checks Run socket selection without touching the user's configuration. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runSocketPath } from '../src/client.ts';

test('explicit socket and home take precedence over AGENT_RUN_HOME', () => {
  assert.equal(runSocketPath('/explicit/api.sock', '/cli-home', '/env-home'), '/explicit/api.sock');
  assert.equal(runSocketPath(undefined, '/cli-home', '/env-home'), '/cli-home/api.sock');
  assert.equal(runSocketPath(undefined, undefined, '/env-home'), '/env-home/api.sock');
  assert.equal(runSocketPath(undefined, undefined, 'relative-run'), resolve('relative-run/api.sock'));
  assert.equal(runSocketPath(undefined, undefined, undefined), undefined);
  assert.equal(runSocketPath('/explicit/api.sock', undefined, ''), '/explicit/api.sock');
  assert.throws(() => runSocketPath(undefined, undefined, ''), /must not be blank/);
});

test('an existing Run home is canonicalized without changing an explicit socket', () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp);
  const directory = mkdtempSync(join(temp, 'run-home-'));
  try {
    const actual = join(directory, 'actual'), alias = join(directory, 'alias');
    mkdirSync(actual); symlinkSync(actual, alias);
    assert.equal(runSocketPath(undefined, undefined, alias), join(actual, 'api.sock'));
    assert.equal(runSocketPath(join(alias, 'api.sock'), undefined, undefined), join(alias, 'api.sock'));
  } finally { rmSync(directory, { recursive: true }); }
});
