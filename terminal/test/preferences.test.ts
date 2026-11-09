/** Verifies local UI preferences do not overwrite service configuration. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadTheme, saveTheme } from '../src/preferences.ts';

test('appearance preference persists and refuses a substituted symlink', async () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp && path.isAbsolute(temp));
  const directory = await mkdtemp(path.join(temp, 'hub-preferences-test-'));
  const file = path.join(directory, 'preferences.json'), other = path.join(directory, 'connections.json');
  try {
    assert.equal(await loadTheme(file), 'system');
    await writeFile(other, 'untouched');
    await Promise.all([saveTheme('dark', file), saveTheme('light', file)]);
    assert.equal(await loadTheme(file), 'light');
    const module = new URL('../src/preferences.ts', import.meta.url).href;
    const writer = (theme: string) => spawn(process.execPath, ['--input-type=module', '-e', `import { saveTheme } from ${JSON.stringify(module)}; for (let i = 0; i < 12; i++) await saveTheme(${JSON.stringify(theme)}, ${JSON.stringify(file)});`], { stdio: 'ignore' });
    const first = writer('dark'), second = writer('light');
    const exits = await Promise.all([once(first, 'close'), once(second, 'close')]);
    assert.deepEqual(exits.map(([code]) => code), [0, 0]);
    assert.ok(['dark', 'light'].includes(await loadTheme(file)));
    assert.deepEqual((await readdir(directory)).sort(), ['connections.json', 'preferences.json']);
    await rm(file);
    await symlink(other, file);
    await assert.rejects(saveTheme('dark', file));
    assert.equal(await readFile(other, 'utf8'), 'untouched');
  } finally { await rm(directory, { recursive: true }); }
});
