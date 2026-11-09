/** Builds the native observer and one Bun executable for the current Linux x64 host. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const terminal = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.versions.bun || process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The standalone build currently supports Linux x64 with glibc.');
}
const env = { ...process.env, CARGO_TARGET_DIR: join(terminal, 'observer', 'target') };

/** Runs one build step, preserving its diagnostics and exit status. */
function build(command, args) {
  const result = spawnSync(command, args, { cwd: terminal, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unknown'}).`);
}

build('cargo', ['build', '--release', '--locked', '--target', 'x86_64-unknown-linux-gnu', '--manifest-path', 'observer/Cargo.toml']);
const observer = join(terminal, 'observer', 'target', 'x86_64-unknown-linux-gnu', 'release', 'agent-hub-observer');
const observerCheck = spawnSync(observer, [], { cwd: terminal, env, input: '{"resource":"invalid.resource"}\n', encoding: 'utf8', timeout: 5000 });
if (observerCheck.error) throw observerCheck.error;
if (observerCheck.status !== 0 || !observerCheck.stdout.includes('"invalid"')) throw new Error('The native observer did not pass its startup check.');
const outputDirectory = join(terminal, 'dist');
mkdirSync(outputDirectory, { recursive: true });
// Bun embeds the output basename; keep it stable while isolating concurrent builds.
const candidateDirectory = mkdtempSync(join(outputDirectory, '.agent-hub-build-'));
const candidate = join(candidateDirectory, 'agent-hub');
try {
  build(process.execPath, ['build', '--no-install', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', 'src/standalone.mjs', '--outfile', candidate, '--define', 'process.env.OPENTUI_LIBC="glibc"']);
  const check = spawnSync(candidate, ['--help'], { cwd: terminal, env, encoding: 'utf8' });
  if (check.error) throw check.error;
  if (check.status !== 0 || !check.stdout.includes('Usage:')) throw new Error('The standalone binary did not pass its startup check.');
  renameSync(candidate, join(outputDirectory, 'agent-hub'));
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true });
}
