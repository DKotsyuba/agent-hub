/** Local interface appearance only; service connections and grants are never changed. */
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Available terminal appearance preferences. */
export type Theme = 'system' | 'dark' | 'light';

/** Resolves the app-owned preference file, separate from connection configuration. */
function preferencePath(): string {
  const base = process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : path.join(homedir(), '.config');
  return path.join(base, 'dev.agent-mcp.hub', 'terminal-preferences.json');
}

/** Reads a bounded preference; a missing or malformed file falls back to system. */
export async function loadTheme(filename = preferencePath()): Promise<Theme> {
  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    let value: string;
    try {
      if (!(await file.stat()).isFile()) return 'system';
      const buffer = Buffer.alloc(4097), result = await file.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > 4096) return 'system';
      value = buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally { await file.close(); }
    const theme = JSON.parse(value)?.theme;
    return theme === 'dark' || theme === 'light' ? theme : 'system';
  } catch { return 'system'; }
}

let pendingSave = Promise.resolve();

/** Atomically replaces one complete preference without following a substituted symlink. */
export function saveTheme(theme: Theme, filename = preferencePath()): Promise<void> {
  const next = pendingSave.catch(() => {}).then(async () => {
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { if (!(await lstat(filename)).isFile()) throw new Error('preference_file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, `.terminal-preferences-${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(JSON.stringify({ theme }) + '\n'); await file.sync(); await file.close(); await rename(temporary, filename); }
    catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  });
  pendingSave = next;
  return next;
}
