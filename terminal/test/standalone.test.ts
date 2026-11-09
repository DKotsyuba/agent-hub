/** Checks the built executable without Node, Bun or project sources on its search path. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import metadata from '../package.json' with { type: 'json' };

const binary = fileURLToPath(new URL('../dist/agent-hub', import.meta.url));

test('standalone CLI uses and cleans a private runtime directory', { skip: existsSync(binary) ? false : 'standalone binary has not been built' }, () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp && isAbsolute(temp));
  const directory = mkdtempSync(join(temp, 'hub-binary-test-'));
  const runtime = join(directory, 'runtime'), home = join(directory, 'home'), link = join(directory, 'runtime-link');
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  try {
    const env = { HOME: home, PATH: '', TMPDIR: runtime, TMP: runtime, TEMP: runtime, TERM: 'xterm-256color' };
    for (const [args, status] of [[['--help'], 0], [['--invalid'], 2], [['--pool'], 2], [['--pool', 'invalid/id'], 2], [['--broker-uid', '1'], 2], [['--socket', '/run.sock', '--broker-uid', '-1'], 2], [['--demo'], 1], [['--demo', '--pool', 'demo-pool'], 1], [['--demo', '--pool=demo-pool', '.'], 1], [['--socket', '/run.sock', '--broker-uid', '1'], 1], [['--home', '.'], 1]] as const) {
      const result = spawnSync(binary, args, { cwd: directory, env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, status, result.stderr);
      if (status === 0) assert.match(result.stdout, /Usage: agent-hub/);
      assert.deepEqual(readdirSync(runtime), [], 'the extracted runtime is removed on exit');
    }
    for (const flag of ['--version', '-V']) {
      const result = spawnSync(binary, [flag], { cwd: directory, env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `agent-hub ${metadata.version}\n`);
      assert.deepEqual(readdirSync(runtime), [], 'version checks remove the extracted runtime');
    }
    symlinkSync(runtime, link);
    const result = spawnSync(binary, ['--help'], {
      cwd: directory,
      env: { ...env, HOME: join(directory, 'missing'), TMPDIR: link, TMP: link, TEMP: link },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No private executable runtime directory/);
    assert.deepEqual(readdirSync(runtime), [], 'a symlink cannot redirect runtime extraction');
  } finally { rmSync(directory, { recursive: true }); }
});
