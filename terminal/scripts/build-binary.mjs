/** Builds one Bun executable for the current Linux x64 host. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const terminal = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.versions.bun || process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The standalone build currently supports Linux x64 with glibc.');
}
/** Runs one build step, preserving its diagnostics and exit status. */
function build(command, args) {
  const result = spawnSync(command, args, { cwd: terminal, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unknown'}).`);
}

const outputDirectory = join(terminal, 'dist');
mkdirSync(outputDirectory, { recursive: true });
// Bun embeds the output basename; keep it stable while isolating concurrent builds.
const candidateDirectory = mkdtempSync(join(outputDirectory, '.agent-hub-build-'));
const candidate = join(candidateDirectory, 'agent-hub');
try {
  build(process.execPath, ['build', '--no-install', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', 'src/standalone.mjs', '--outfile', candidate, '--define', 'process.env.OPENTUI_LIBC="glibc"']);
  const check = spawnSync(candidate, ['--help'], { cwd: terminal, encoding: 'utf8' });
  if (check.error) throw check.error;
  if (check.status !== 0 || !check.stdout.includes('Usage:')) throw new Error(`The standalone binary did not pass its startup check: ${check.stderr.trim() || check.status}`);
  renameSync(candidate, join(outputDirectory, 'agent-hub'));
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true });
}
