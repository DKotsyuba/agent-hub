#!/usr/bin/env node
/**
 * Release helper for the Agent Hub distribution (Linux x86-64).
 *
 *   node scripts/release.mjs prepare <X.Y.Z>          bump every version field with minimal text edits
 *   node scripts/release.mjs check <X.Y.Z>            require every version field and the CHANGELOG section to match
 *   node scripts/release.mjs notes <X.Y.Z>            print the CHANGELOG section as release notes
 *   npm run build:release -- [outdir]                 build and verify a complete archive
 *   node scripts/release.mjs package <X.Y.Z> <outdir> [--epoch SECONDS]
 *                                                     assemble the release assets and SHA256SUMS
 *   node scripts/release.mjs verify <X.Y.Z> <outdir> [--forbid PATH]...
 *                                                     re-check hashes, layout, version and embedded paths
 * Runs under Node 24+ or Bun. The assets are:
 *   agent-hub-<version>-linux-x86_64.tar.gz and SHA256SUMS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
/** Paths that must never appear in a shipped binary, in addition to anything passed with --forbid. */
const ALWAYS_FORBIDDEN = ['/home/', '/Users/'];

/** Rejects the operation while allowing archive scratch cleanup to finish. */
function fail(message) {
  throw new Error(message);
}

/** Returns the argument as a validated plain semantic version. */
function versionArgument(value) {
  if (!SEMVER.test(value ?? '')) fail(`Expected a version like 1.2.3, got "${value ?? ''}".`);
  return value;
}

/**
 * Version fields as [file, pattern, kind]. Every pattern captures the current version in group 2 and is
 * applied to the first match only, so the files are edited in place and never re-serialized.
 */
const VERSION_FIELDS = [
  ['package.json', /^(\{\s*"name": "agent-hub",\s*(?:"private": true,\s*)?"version": ")([^"]+)(")/s],
  ['package-lock.json', /^(\{\s*"name": "agent-hub",\s*"version": ")([^"]+)(")/s],
  ['package-lock.json', /("packages": \{\s*"": \{\s*"name": "agent-hub",\s*"version": ")([^"]+)(")/s],
  ['terminal/package.json', /^(\{\s*"name": "agent-hub-terminal",\s*"version": ")([^"]+)(")/s],
  ['package-lock.json', /("terminal": \{\s*"name": "agent-hub-terminal",\s*"version": ")([^"]+)(")/s],
  ['server/observer/Cargo.toml', /(\[package\]\nname = "agent-hub-observer"\nversion = ")([^"]+)(")/],
  ['server/observer/Cargo.lock', /(\[\[package\]\]\nname = "agent-hub-observer"\nversion = ")([^"]+)(")/],
  ['src-tauri/Cargo.toml', /(\[package\]\nname = "agent-hub"\nversion = ")([^"]+)(")/],
  ['src-tauri/Cargo.lock', /(\[\[package\]\]\nname = "agent-hub"\nversion = ")([^"]+)(")/],
  ['src-tauri/tauri.conf.json', /^(\{[^]*?"version": ")([^"]+)(")/],
];

/** Reads a repository file as text. */
function read(file) {
  return readFileSync(join(root, file), 'utf8');
}

/** Returns the CHANGELOG section body of a version, or null when it has no heading. */
function changelogSection(version) {
  const lines = read('CHANGELOG.md').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && /^(## |\[[^\]]+\]: )/.test(line));
  if (end < 0) end = lines.length;
  return `${lines.slice(start + 1, end).join('\n').trim()}\n`;
}

/** Bumps every version field in place. */
function prepare(version) {
  const edits = new Map();
  for (const [file, pattern] of VERSION_FIELDS) {
    const text = edits.get(file) ?? read(file);
    if (!pattern.test(text)) fail(`${file}: version field not found (pattern ${pattern}).`);
    edits.set(file, text.replace(pattern, `$1${version}$3`));
  }
  for (const [file, text] of edits) writeFileSync(join(root, file), text);
  console.log(`Bumped ${edits.size} files to ${version}.`);
  console.log(`Next: add "## [${version}] - YYYY-MM-DD" to CHANGELOG.md with its link reference, run`);
  console.log('`node scripts/generate-notices.mjs` if a lockfile or pin changed, then `node scripts/release.mjs check ' + version + '`.');
}

/** Fails unless every version field and the CHANGELOG agree with the version. */
function check(version) {
  const problems = [];
  for (const [file, pattern] of VERSION_FIELDS) {
    const match = read(file).match(pattern);
    if (!match) problems.push(`${file}: version field not found`);
    else if (match[2] !== version) problems.push(`${file}: ${match[2]} (expected ${version})`);
  }
  const section = changelogSection(version);
  if (section === null) problems.push(`CHANGELOG.md: no "## [${version}]" section`);
  else if (section.trim() === '') problems.push(`CHANGELOG.md: the ${version} section is empty`);
  if (!read('CHANGELOG.md').includes(`[${version}]: https://github.com/`)) problems.push(`CHANGELOG.md: no [${version}] link reference`);
  if (problems.length > 0) fail(`Version check failed:\n  ${problems.join('\n  ')}`);
  console.log(`All version fields and the changelog agree on ${version}.`);
}

/** Prints the release notes of a version. */
function notes(version) {
  const section = changelogSection(version);
  if (section === null || section.trim() === '') fail(`CHANGELOG.md has no notes for ${version}.`);
  process.stdout.write(section);
}

/** Returns the SHA-256 hex digest of a file. */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Runs a command, failing with its diagnostics. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed:\n${result.stderr ?? ''}`);
  return result.stdout;
}

/** Names of the release assets for a version. */
function assetNames(version) {
  return { archive: `agent-hub-${version}-linux-x86_64.tar.gz` };
}

/** Parses an optional `--epoch SECONDS` for deterministic archive timestamps. */
function epochOption(args) {
  const index = args.indexOf('--epoch');
  const value = index >= 0 ? args[index + 1] : process.env.SOURCE_DATE_EPOCH;
  if (value === undefined) fail('Pass --epoch SECONDS or set SOURCE_DATE_EPOCH (for example the commit time) for a reproducible archive.');
  if (!/^\d+$/.test(value)) fail(`Invalid epoch "${value}".`);
  return value;
}

/** Executables and supporting files in the release tree. */
const binaries = ['bin/agent-hub', 'bin/hub-server', 'libexec/agent-hub-observer'];
const supporting = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'etc/agent-hub/connections.json', 'share/systemd/agent-hub.service'];
const observerTarget = resolve(root, process.env.CARGO_TARGET_DIR ?? 'server/observer/target');

/** Assembles the built distribution with fixed archive ownership, times and modes. */
function packageRelease(version, outdir, epoch) {
  check(version);
  const { archive } = assetNames(version);
  mkdirSync(outdir, { recursive: true });
  if (readdirSync(outdir).length > 0) fail(`${outdir} is not empty.`);
  const stage = mkdtempSync(join(outdir, '.stage-'));
  try {
    const top = archive.slice(0, -7);
    const tree = join(stage, top);
    const sources = [
      'terminal/dist/agent-hub', 'server/dist/hub-server', join(observerTarget, 'release/agent-hub-observer'),
      'LICENSE', 'THIRD_PARTY_NOTICES.md', 'packaging/etc/agent-hub/connections.json', 'server/systemd/agent-hub.service',
    ];
    [...binaries, ...supporting].forEach((file, index) => {
      const target = join(tree, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(resolve(root, sources[index]), target);
      chmodSync(target, index < binaries.length ? 0o755 : 0o644);
    });
    cpSync(join(root, 'dist'), join(tree, 'share/web'), { recursive: true });
    const tarFile = join(stage, 'archive.tar');
    run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner',
      '--mode=u+rwX,go+rX,go-w,a-s', '--format=gnu', '-cf', tarFile, '-C', stage, top]);
    const gzip = spawnSync('gzip', ['-n', '-9', '-c', tarFile], { maxBuffer: 1 << 30 });
    if (gzip.status !== 0) fail(`gzip failed: ${gzip.error ?? gzip.stderr}`);
    writeFileSync(join(outdir, archive), gzip.stdout);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const sums = `${sha256(join(outdir, archive))}  ${archive}\n`;
  writeFileSync(join(outdir, 'SHA256SUMS'), sums);
  process.stdout.write(sums);
}

/** Checks exact release assets, archive contents, executable identity and forbidden build paths. */
function verify(version, outdir, forbidden) {
  const { archive } = assetNames(version);
  const expected = ['SHA256SUMS', archive];
  const actual = readdirSync(outdir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Asset set mismatch: [${actual.join(', ')}].`);
  const archivePath = join(outdir, archive);
  if (readFileSync(join(outdir, 'SHA256SUMS'), 'utf8') !== `${sha256(archivePath)}  ${archive}\n`) {
    fail('SHA256SUMS does not match the archive.');
  }
  const prefix = archive.slice(0, -7) + '/';
  const files = run('tar', ['-tzf', archivePath]).trimEnd().split('\n');
  const allowed = new Set([...binaries, ...supporting, '', 'bin/', 'libexec/', 'etc/', 'etc/agent-hub/', 'share/', 'share/systemd/',
    'share/web/', 'share/web/index.html', 'share/web/favicon.svg', 'share/web/assets/',
    'share/web/sw.js', 'share/web/manifest.webmanifest', 'share/web/manifest-dark.webmanifest',
    'share/web/icon-192.png', 'share/web/icon-512.png', 'share/web/apple-touch-icon.png']);
  if (new Set(files).size !== files.length || files.some(entry => {
    const path = entry.slice(prefix.length);
    return !entry.startsWith(prefix) || (!allowed.has(path) && !/^share\/web\/assets\/[\w.-]+$/.test(path) || path.endsWith('/..'));
  })) fail('Unexpected archive entry.');
  const required = [...binaries, ...supporting, 'share/web/index.html'];
  if (required.some(path => !files.includes(prefix + path)) ||
      !files.some(path => path.startsWith(prefix + 'share/web/assets/') && path.endsWith('.js')) ||
      !files.some(path => path.startsWith(prefix + 'share/web/assets/') && path.endsWith('.css'))) fail('Archive is missing release files.');
  const listing = run('tar', ['-tvzf', archivePath]).trimEnd().split('\n');
  if (listing.length !== files.length || listing.some((entry, index) => {
    const path = files[index].slice(prefix.length);
    const mode = files[index].endsWith('/') ? 'drwxr-xr-x' : binaries.includes(path) ? '-rwxr-xr-x' : '-rw-r--r--';
    return !entry.startsWith(mode + ' ');
  })) fail('Archive contains a special file or unexpected permissions.');
  const scratch = mkdtempSync(join(outdir, '.verify-'));
  try {
    run('tar', ['--same-permissions', '-xzf', archivePath, '-C', scratch]);
    const top = join(scratch, prefix);
    const needles = [...ALWAYS_FORBIDDEN, ...forbidden].filter(Boolean);
    for (const entry of files) {
      if (entry.endsWith('/')) continue;
      const path = join(scratch, entry);
      const data = readFileSync(path);
      for (const needle of needles) {
        if (data.includes(Buffer.from(needle))) fail(`${entry} embeds "${needle}".`);
      }
    }
    const output = run(join(top, 'bin/agent-hub'), ['--version']).trim();
    if (output !== `agent-hub ${version}`) fail(`Unexpected TUI version: "${output}".`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Assets for ${version} are consistent.`);
}

/** Builds the locked Linux distribution with remapped native paths. */
function buildRelease(outdir) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !process.report.getReport().header.glibcVersionRuntime) {
    fail('The release build requires Linux x86-64 with glibc.');
  }
  if (/[\s]/.test(root) || /[\s]/.test(process.env.CARGO_HOME ?? '')) fail('Build paths must not contain whitespace for Rust path remapping.');
  const version = versionArgument(JSON.parse(read('package.json')).version);
  const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
  const env = { ...process.env, CARGO_TARGET_DIR: observerTarget,
    RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${root}=/build/agent-hub`, `--remap-path-prefix=${cargoHome}=/cargo`].filter(Boolean).join(' ') };
  for (const script of ['server:build', 'terminal:build', 'web:build']) run('npm', ['run', script], { cwd: root, stdio: 'inherit' });
  run('cargo', ['build', '--offline', '--locked', '--release', '--manifest-path', 'server/observer/Cargo.toml'], { cwd: root, stdio: 'inherit', env });
  packageRelease(version, outdir, process.env.SOURCE_DATE_EPOCH ?? run('git', ['log', '-1', '--format=%ct'], { cwd: root }).trim());
  verify(version, outdir, [root, cargoHome, process.env.TMPDIR]);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'prepare') prepare(versionArgument(rest[0]));
  else if (command === 'check') check(versionArgument(rest[0]));
  else if (command === 'notes') notes(versionArgument(rest[0]));
  else if (command === 'package') {
    if (rest.length < 2) fail('Usage: package <version> <outdir> [--epoch SECONDS]');
    packageRelease(versionArgument(rest[0]), resolve(rest[1]), epochOption(rest.slice(2)));
  } else if (command === 'build') {
    if (rest.length > 1) fail('Usage: build [outdir]');
    buildRelease(resolve(rest[0] ?? join(root, '.tmp/release')));
  } else if (command === 'verify') {
    const forbidden = [];
    for (let index = 2; index < rest.length; index += 1) {
      if (rest[index] !== '--forbid') fail(`Unknown argument ${rest[index]}.`);
      forbidden.push(rest[++index] ?? fail('--forbid needs a path'));
    }
    verify(versionArgument(rest[0]), resolve(rest[1] ?? fail('Usage: verify <version> <outdir>')), forbidden);
  } else fail('Usage: release.mjs prepare|check|notes|build|package|verify (see the header of this file).');
} catch (error) {
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
}
