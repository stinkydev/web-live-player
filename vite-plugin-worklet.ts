import { resolve } from 'path';
import { build } from 'esbuild';
import type { Plugin } from 'vite';

const SUFFIX = '?worklet-source';

/**
 * `import source from './x.worklet.ts?worklet-source'` bundles the module and its imports into
 * one self-contained script and imports it as a string, for AudioWorklet.addModule() through
 * a Blob URL. The worklet stays real, typed, testable TypeScript, and consumers of the library
 * have no separate file to serve.
 */
export function workletSource(): Plugin {
  return {
    name: 'worklet-source',
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null;
      const file = id.slice(0, -SUFFIX.length);
      const result = await build({
        entryPoints: [file],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2020',
        minify: true,
        metafile: true,
        logLevel: 'silent',
      });
      for (const input of Object.keys(result.metafile!.inputs)) {
        this.addWatchFile(resolve(input));
      }
      return `export default ${JSON.stringify(result.outputFiles![0].text)};`;
    },
  };
}
