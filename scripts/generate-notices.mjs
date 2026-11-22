#!/usr/bin/env node
/**
 * Generates THIRD_PARTY_NOTICES.md reproducibly for the standalone Linux x86-64 terminal executable.
 *
 * Inputs (no network is used for npm and Rust, only for the pinned Bun license unless --bun-license is given):
 *   - package-lock.json and the terminal runtime packages installed by `npm ci --ignore-scripts` at the root
 *   - terminal/observer/Cargo.lock through `cargo metadata --locked --filter-platform x86_64-unknown-linux-gnu`
 *     and the `.crate` archives in the Cargo registry cache (run `cargo fetch --locked` first)
 *   - the upstream Bun `LICENSE.md` at the pinned tag
 *
 * Usage: node scripts/generate-notices.mjs [--check] [--output FILE] [--bun-license FILE]
 *   --check          regenerate in memory and fail when the notices file differs
 *   --output FILE    write (or compare with) FILE instead of THIRD_PARTY_NOTICES.md in the repository root
 *   --bun-license F  read the Bun LICENSE.md from F instead of downloading it
 * The output depends only on the inputs above: no timestamps, absolute paths or host names.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const terminal = join(root, 'terminal');
const RUST_TARGET = 'x86_64-unknown-linux-gnu';
/** Bun runtime embedded by `bun build --compile`; keep equal to the Bun pin in .github/workflows. */
const BUN_VERSION = '1.4.4';
const OPENTUI_CORE = '@opentui/core';
const OPENTUI_NATIVE = '@opentui/core-linux-x64';
/** OpenTUI notice files in output order; a new, unlisted notice file in a package fails generation. */
const OPENTUI_FILES = [
  [OPENTUI_CORE, ['LICENSE']],
  [OPENTUI_NATIVE, ['LICENSE', 'LICENSE-FFMPEG', 'LICENSE-GHOSTTY', 'LICENSE-LCMS2', 'LICENSE-LIBWEBP', 'AUTHORS-LIBWEBP', 'PATENTS-LIBWEBP', 'LICENSE-STB', 'LICENSE-WUFFS', 'LICENSE-ZLIB', 'FFMPEG-SOURCE.md']],
];
/** Names of files that carry license or notice text at the top level of a package. */
const NOTICE_FILE = /^(LICEN[CS]E|COPYING|UNLICENSE|NOTICES?|AUTHORS|PATENTS|FFMPEG-SOURCE)([-._].*)?$/i;

/** Aborts generation with a one-line diagnostic. */
function fail(message) {
  console.error(`generate-notices: ${message}`);
  process.exit(1);
}

/** Parses the command line into its supported options. */
function parseArguments(argv) {
  const options = { check: false, output: join(root, 'THIRD_PARTY_NOTICES.md'), bunLicense: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--output') options.output = resolve(argv[++index] ?? fail('--output needs a file'));
    else if (argument === '--bun-license') options.bunLicense = resolve(argv[++index] ?? fail('--bun-license needs a file'));
    else fail(`Unknown argument: ${argument}`);
  }
  return options;
}

/** Normalizes line endings and trailing whitespace so output does not depend on the source packaging. */
function normalize(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** Wraps verbatim text in a fenced block that the text itself cannot close. */
function fenced(text) {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}text\n${text}\n${fence}`;
}

/** Orders strings by code point so the result is independent of locale. */
function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Runs a command and returns stdout, failing with its diagnostics. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

/** Reads the license text of the Bun runtime from a file or the pinned upstream tag. */
async function bunLicense(file) {
  if (file) return normalize(readFileSync(file, 'utf8'));
  const url = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md`;
  const response = await fetch(url);
  if (!response.ok) fail(`Could not download ${url}: HTTP ${response.status}`);
  return normalize(await response.text());
}

/** Reads the manifest of an installed npm package directory, which must match the expected version. */
function installedManifest(directory, name, version) {
  if (!existsSync(join(directory, 'package.json'))) fail(`${name} is not installed; run npm ci --ignore-scripts from the repository root.`);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== version) fail(`${name}: installed ${manifest.version} differs from the lock ${version}.`);
  return manifest;
}

/** Lists the notice files at the top level of a package directory. */
function noticeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && NOTICE_FILE.test(entry.name)).map((entry) => entry.name).sort(compare);
}

/** Finds the nearest installed dependency of a workspace or package in the root lock. */
function lockedDependency(lock, owner, name) {
  for (let directory = owner; directory !== '.'; directory = dirname(directory)) {
    const path = `${directory}/node_modules/${name}`;
    if (lock.packages[path]) return path;
  }
  return lock.packages[`node_modules/${name}`] ? `node_modules/${name}` : null;
}

/** Walks runtime and required peer edges reachable from Terminal, excluding platform optionals. */
function terminalRuntimePackages(lock) {
  const packages = new Map();

  /** Visits one package by its install location to preserve separately pinned nested dependencies. */
  function visit(owner, name) {
    const path = lockedDependency(lock, owner, name);
    if (!path) fail(`Missing locked terminal dependency: ${name} from ${owner}.`);
    if (packages.has(path)) return;
    const entry = lock.packages[path];
    packages.set(path, { name: path.replace(/^node_modules\//, '').replaceAll('/node_modules/', '/'), path, version: entry.version, license: entry.license });
    for (const child of Object.keys(entry.dependencies ?? {})) visit(path, child);
    for (const peer of Object.keys(entry.peerDependencies ?? {})) {
      if (!entry.peerDependenciesMeta?.[peer]?.optional) visit(path, peer);
    }
  }

  for (const name of Object.keys(lock.packages.terminal.dependencies)) visit('terminal', name);
  return [...packages.values()];
}

/** Renders section 2: the OpenTUI packages with every notice file reproduced verbatim. */
function openTuiSection(lock) {
  const core = lockedDependency(lock, 'terminal', OPENTUI_CORE);
  const native = core && lockedDependency(lock, core, OPENTUI_NATIVE);
  if (!core || !native) fail('OpenTUI core and Linux native package must be in the root lock.');
  const version = lock.packages[core].version;
  if (lock.packages[native].version !== version) fail('OpenTUI core and native package versions differ.');
  const lines = [
    `## 2. OpenTUI ${version}`,
    '',
    `\`${OPENTUI_CORE}\` (MIT) and the native package \`${OPENTUI_NATIVE}\` (MIT AND LGPL-2.1-or-later) are embedded. The native library statically links a decode-only FFmpeg build (LGPL-2.1-or-later, unmodified source; see the build description below), zlib, stb, wuffs, libwebp, lcms2 and ghostty components. Source: <https://github.com/anomalyco/opentui/tree/v${version}>.`,
    '',
  ];
  for (const [name, files] of OPENTUI_FILES) {
    const directory = join(root, name === OPENTUI_CORE ? core : native);
    installedManifest(directory, name, version);
    const unlisted = noticeFiles(directory).filter((file) => !files.includes(file));
    if (unlisted.length > 0) fail(`${name}@${version} has unlisted notice files: ${unlisted.join(', ')}. Review them and update OPENTUI_FILES.`);
    for (const file of files) {
      lines.push(`### ${name}@${version}: \`${file}\``, '', fenced(normalize(readFileSync(join(directory, file), 'utf8'))), '');
    }
  }
  return lines;
}

/** Renders section 3: runtime npm packages other than OpenTUI, from the lockfile. */
function npmSection(lock) {
  const packages = terminalRuntimePackages(lock).filter(entry => entry.path !== lockedDependency(lock, 'terminal', OPENTUI_CORE));
  packages.sort((left, right) => compare(left.name, right.name));
  const lines = [
    '## 3. Other npm runtime packages',
    '',
    'Terminal runtime packages from the root `package-lock.json` installed for linux-x64, excluding the OpenTUI packages above.',
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...packages.map((entry) => `| \`${entry.name}\` | ${entry.version} | ${entry.license} |`),
    '',
  ];
  for (const entry of packages) {
    const directory = join(root, entry.path);
    installedManifest(directory, entry.name, entry.version);
    const files = noticeFiles(directory);
    if (files.length !== 1) fail(`${entry.name}@${entry.version}: expected exactly one license file, found [${files.join(', ')}].`);
    lines.push(`### ${entry.name}@${entry.version} (${entry.license})`, '', fenced(normalize(readFileSync(join(directory, files[0]), 'utf8'))), '');
  }
  return lines;
}

/** Locates the Cargo registry cache archive of a published crate. */
function crateArchive(name, version) {
  const cache = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'cache');
  if (existsSync(cache)) {
    for (const registry of readdirSync(cache).sort(compare)) {
      const candidate = join(cache, registry, `${name}-${version}.crate`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return fail(`${name}-${version}.crate is not in the Cargo registry cache; run cargo fetch --locked --manifest-path terminal/observer/Cargo.toml.`);
}

/** Reads the notice files at the top level of a published crate archive. */
function crateNotices(name, version) {
  const archive = crateArchive(name, version);
  const prefix = `${name}-${version}/`;
  const files = run('tar', ['-tzf', archive]).split('\n')
    .filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/') && NOTICE_FILE.test(entry.slice(prefix.length)))
    .map((entry) => entry.slice(prefix.length)).sort(compare);
  return files.map((file) => ({ file, text: normalize(run('tar', ['-xzOf', archive, `${prefix}${file}`])) }));
}

/** Renders section 4: the normal and build dependency closure of the observer, with identical texts shown once. */
function rustSection() {
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', RUST_TARGET, '--manifest-path', join(terminal, 'observer', 'Cargo.toml')]));
  const byId = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const included = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length > 0) {
    for (const dependency of nodes.get(pending.pop()).deps) {
      if (!dependency.dep_kinds.some((kind) => kind.kind !== 'dev') || included.has(dependency.pkg)) continue;
      included.add(dependency.pkg);
      pending.push(dependency.pkg);
    }
  }
  const crates = [...included].map((id) => byId.get(id)).sort((left, right) => compare(left.name, right.name) || compare(left.version, right.version));
  const lines = [
    '## 4. Rust observer crates',
    '',
    `Crates compiled for \`${RUST_TARGET}\` (normal and build dependencies, including procedural macros) from \`terminal/observer/Cargo.lock\`. License texts are taken from the published crate sources; identical texts are shown once.`,
    '',
    '| Crate | Version | License expression |',
    '|---|---|---|',
    ...crates.map((entry) => `| \`${entry.name}\` | ${entry.version} | ${entry.license} |`),
    '',
    '### License texts',
    '',
  ];
  const groups = new Map();
  for (const crate of crates) {
    const notices = crateNotices(crate.name, crate.version);
    if (notices.length === 0) fail(`${crate.name}@${crate.version} has no license file in its published source.`);
    for (const { file, text } of notices) {
      const members = groups.get(text) ?? [];
      members.push({ crate, file });
      groups.set(text, members);
    }
  }
  const ordered = [...groups.entries()].map(([text, members]) => ({ text, members }))
    .sort((left, right) => compare(left.members[0].crate.name, right.members[0].crate.name) || compare(left.members[0].crate.version, right.members[0].crate.version) || compare(left.members[0].file, right.members[0].file));
  for (const { text, members } of ordered) {
    lines.push(`Applies to: ${members.map(({ crate, file }) => `${crate.name} ${crate.version} (${file})`).join(', ')}`, '', fenced(text), '');
  }
  return lines;
}

/** Builds the complete notices document. */
async function generate(options) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const bun = await bunLicense(options.bunLicense);
  const lines = [
    '# Third-party notices',
    '',
    'Agent Hub itself is MIT-licensed (see `LICENSE`). The standalone Linux x86-64 executable (`agent-hub`) additionally embeds or ships the third-party components listed below. Each component remains under its own license; license texts are reproduced verbatim from the upstream packages or releases at the pinned versions.',
    '',
    `This file is generated by \`node scripts/generate-notices.mjs\` from \`package-lock.json\`, the installed npm packages, \`terminal/observer/Cargo.lock\` (via \`cargo metadata --locked --filter-platform ${RUST_TARGET}\`) and the upstream Bun v${BUN_VERSION} \`LICENSE.md\`. Regenerate it whenever a lockfile or the pinned Bun version changes; \`--check\` verifies that it is current.`,
    '',
    'Contents: 1. Bun runtime, 2. OpenTUI, 3. other npm runtime packages, 4. Rust observer crates.',
    '',
    `## 1. Bun runtime ${BUN_VERSION}`,
    '',
    `The standalone executable is produced by \`bun build --compile\` and embeds the Bun ${BUN_VERSION} runtime. Bun is MIT-licensed and statically links JavaScriptCore/WebKit (LGPL-2) and the libraries listed in its license file. Source: <https://github.com/oven-sh/bun/tree/bun-v${BUN_VERSION}>. Patched WebKit source: <https://github.com/oven-sh/webkit>. Upstream \`LICENSE.md\` at tag \`bun-v${BUN_VERSION}\`:`,
    '',
    fenced(bun),
    '',
    ...openTuiSection(lock),
    ...npmSection(lock),
    ...rustSection(),
  ];
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

const options = parseArguments(process.argv.slice(2));
const document = await generate(options);
if (options.check) {
  const current = existsSync(options.output) ? readFileSync(options.output, 'utf8') : '';
  if (current !== document) fail(`${options.output} is out of date; run node scripts/generate-notices.mjs.`);
  console.log('Third-party notices are up to date.');
} else {
  writeFileSync(options.output, document);
  console.log(`Wrote ${options.output}`);
}
