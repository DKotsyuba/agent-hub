#!/usr/bin/env node
/**
 * Release helper for the Agent Hub terminal build (Linux x86-64).
 *
 *   node scripts/release.mjs prepare <X.Y.Z>          bump every version field with minimal text edits
 *   node scripts/release.mjs check <X.Y.Z>            require every version field and the CHANGELOG section to match
 *   node scripts/release.mjs notes <X.Y.Z>            print the CHANGELOG section as release notes
 *   node scripts/release.mjs package <X.Y.Z> <binary> <outdir> [--epoch SECONDS]
 *                                                     assemble the release assets and SHA256SUMS
 *   node scripts/release.mjs verify <X.Y.Z> <outdir> [--forbid PATH]...
 *                                                     re-check hashes, layout, version and embedded paths
 * Runs under Node 24+ or Bun. The assets are:
 *   agent-hub-<version>-linux-x86_64.tar.gz, agent-hub-linux-x86_64, THIRD_PARTY_NOTICES.md, SHA256SUMS.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
/** Paths that must never appear in a shipped binary, in addition to anything passed with --forbid. */
const ALWAYS_FORBIDDEN = ['/home/', '/Users/'];

/** Aborts with a one-line diagnostic. */
function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
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
  ['terminal/observer/Cargo.toml', /(\[package\]\nname = "agent-hub-observer"\nversion = ")([^"]+)(")/],
  ['terminal/observer/Cargo.lock', /(\[\[package\]\]\nname = "agent-hub-observer"\nversion = ")([^"]+)(")/],
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
  return { archive: `agent-hub-${version}-linux-x86_64.tar.gz`, binary: 'agent-hub-linux-x86_64', notices: 'THIRD_PARTY_NOTICES.md' };
}

/** Parses an optional `--epoch SECONDS` for deterministic archive timestamps. */
function epochOption(args) {
  const index = args.indexOf('--epoch');
  const value = index >= 0 ? args[index + 1] : process.env.SOURCE_DATE_EPOCH;
  if (value === undefined) fail('Pass --epoch SECONDS or set SOURCE_DATE_EPOCH (for example the commit time) for a reproducible archive.');
  if (!/^\d+$/.test(value)) fail(`Invalid epoch "${value}".`);
  return value;
}

/** Builds the four release assets from a compiled executable. */
function packageRelease(version, binary, outdir, epoch) {
  const names = assetNames(version);
  if (!existsSync(binary)) fail(`${binary} does not exist; run npm run build:binary in terminal/ first.`);
  mkdirSync(outdir, { recursive: true });
  if (readdirSync(outdir).length > 0) fail(`${outdir} is not empty.`);
  const stage = mkdtempSync(join(outdir, '.stage-'));
  try {
    const top = `agent-hub-${version}-linux-x86_64`;
    mkdirSync(join(stage, top, 'etc', 'agent-hub'), { recursive: true });
    copyFileSync(binary, join(stage, top, 'agent-hub'));
    chmodSync(join(stage, top, 'agent-hub'), 0o755);
    copyFileSync(join(root, 'LICENSE'), join(stage, top, 'LICENSE'));
    copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(stage, top, 'THIRD_PARTY_NOTICES.md'));
    copyFileSync(join(root, 'packaging', 'etc', 'agent-hub', 'connections.json'), join(stage, top, 'etc', 'agent-hub', 'connections.json'));
    for (const directory of [top, join(top, 'etc'), join(top, 'etc', 'agent-hub')]) chmodSync(join(stage, directory), 0o755);
    for (const file of [join(top, 'LICENSE'), join(top, 'THIRD_PARTY_NOTICES.md'), join(top, 'etc', 'agent-hub', 'connections.json')]) chmodSync(join(stage, file), 0o644);
    // Deterministic archive: sorted names, fixed owner and times, gzip without name or timestamp.
    const tarFile = join(stage, 'archive.tar');
    run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-cf', tarFile, '-C', stage, top]);
    const gzip = spawnSync('gzip', ['-n', '-9', '-c', tarFile], { maxBuffer: 1 << 30 });
    if (gzip.status !== 0) fail(`gzip failed: ${gzip.stderr}`);
    writeFileSync(join(outdir, names.archive), gzip.stdout);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  copyFileSync(binary, join(outdir, names.binary));
  chmodSync(join(outdir, names.binary), 0o755);
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(outdir, names.notices));
  const sums = [names.archive, names.binary, names.notices].sort().map((name) => `${sha256(join(outdir, name))}  ${name}\n`).join('');
  writeFileSync(join(outdir, 'SHA256SUMS'), sums);
  process.stdout.write(sums);
}

/** True when the buffer contains the ASCII needle. */
function contains(buffer, needle) {
  return buffer.includes(Buffer.from(needle));
}

/** Re-checks an asset directory: exact file set, hashes, executable version and no embedded build paths. */
function verify(version, outdir, forbidden) {
  const names = assetNames(version);
  const expected = [names.archive, names.binary, names.notices, 'SHA256SUMS'].sort();
  const actual = readdirSync(outdir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Asset set mismatch: found [${actual.join(', ')}], expected [${expected.join(', ')}].`);
  const listed = new Map(readFileSync(join(outdir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([^/\s]+)$/);
    if (!match) fail(`Malformed SHA256SUMS line: ${line}`);
    return [match[2], match[1]];
  }));
  for (const name of expected.filter((entry) => entry !== 'SHA256SUMS')) {
    if (listed.get(name) !== sha256(join(outdir, name))) fail(`SHA256SUMS does not match ${name}.`);
  }
  if (listed.size !== 3) fail('SHA256SUMS must list exactly the three assets.');
  const scratch = mkdtempSync(join(outdir, '.verify-'));
  try {
    run('tar', ['-xzf', join(outdir, names.archive), '-C', scratch]);
    const top = join(scratch, `agent-hub-${version}-linux-x86_64`);
    const files = run('tar', ['-tzf', join(outdir, names.archive)]).split('\n').filter(Boolean).sort();
    const prefix = `agent-hub-${version}-linux-x86_64/`;
    const want = ['', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'agent-hub', 'etc/', 'etc/agent-hub/', 'etc/agent-hub/connections.json'].map((entry) => prefix + entry).sort();
    if (JSON.stringify(files) !== JSON.stringify(want)) fail(`Archive layout mismatch: [${files.join(', ')}].`);
    if (sha256(join(top, 'agent-hub')) !== sha256(join(outdir, names.binary))) fail('The archived executable differs from the bare executable.');
    for (const [label, file] of [['bare executable', join(outdir, names.binary)], ['archived notices', join(top, 'THIRD_PARTY_NOTICES.md')]]) {
      const data = readFileSync(file);
      for (const needle of label === 'bare executable' ? [...ALWAYS_FORBIDDEN, ...forbidden] : []) {
        if (contains(data, needle)) fail(`The ${label} embeds "${needle}".`);
      }
    }
    const output = run(join(outdir, names.binary), ['--version']).trim();
    if (output !== `agent-hub ${version}`) fail(`--version printed "${output}", expected "agent-hub ${version}".`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Assets for ${version} are consistent.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'prepare') prepare(versionArgument(rest[0]));
else if (command === 'check') check(versionArgument(rest[0]));
else if (command === 'notes') notes(versionArgument(rest[0]));
else if (command === 'package') {
  if (rest.length < 3) fail('Usage: package <version> <binary> <outdir> [--epoch SECONDS]');
  packageRelease(versionArgument(rest[0]), resolve(rest[1]), resolve(rest[2]), epochOption(rest.slice(3)));
} else if (command === 'verify') {
  const forbidden = [];
  for (let index = 2; index < rest.length; index += 1) {
    if (rest[index] !== '--forbid') fail(`Unknown argument ${rest[index]}.`);
    forbidden.push(rest[++index] ?? fail('--forbid needs a path'));
  }
  verify(versionArgument(rest[0]), resolve(rest[1] ?? fail('Usage: verify <version> <outdir>')), forbidden);
} else fail('Usage: release.mjs prepare|check|notes|package|verify (see the header of this file).');
