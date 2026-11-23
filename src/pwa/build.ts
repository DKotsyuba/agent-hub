/** Emits the root-scope worker after Vite assembles the release shell. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const publicDirectory = new URL('../../public/', import.meta.url);
const worker = new URL('./sw.js', import.meta.url);

/** Embeds the complete build inventory so a changed shell produces a waiting worker. */
export function hubPwa(): Plugin {
  return {
    name: 'agent-hub-pwa',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const shell = bundle['index.html'];
        if (!shell || shell.type !== 'asset') throw new Error('Agent Hub build is missing index.html');
        const workerSource = readFileSync(worker, 'utf8');
        const hash = createHash('sha256').update(shell.source).update(workerSource);
        const publicAssets = readdirSync(publicDirectory, { withFileTypes: true })
          .filter(entry => entry.isFile() && /\.(svg|png|webmanifest)$/.test(entry.name))
          .map(entry => entry.name).sort();
        for (const name of publicAssets) hash.update(name).update(readFileSync(fileURLToPath(new URL(name, publicDirectory))));
        const built = Object.keys(bundle).filter(name => name.startsWith('assets/')).sort();
        for (const name of built) {
          const file = bundle[name]!;
          hash.update(name).update(file.type === 'chunk' ? file.code : file.source);
        }
        const build = { cache: 'agent-hub-shell-' + hash.digest('hex').slice(0, 24), assets: ['/', ...[...publicAssets, ...built].map(name => '/' + name)] };
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: `self.__HUB_BUILD__ = ${JSON.stringify(build)};\n${workerSource}` });
      },
    },
  };
}
