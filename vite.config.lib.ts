import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';
import { workletSource } from './vite-plugin-worklet.ts';

export default defineConfig({
  // Handle tinyh264's .asset files as URLs
  assetsInclude: ['**/*.asset'],
  
  // Rolldown emits `{}` for import.meta in CJS output, which breaks the encoder workers'
  // `new URL(..., import.meta.url)`. Resolve against self.location in both formats, as
  // the Rollup-based build did.
  define: {
    'import.meta.url': 'self.location.href',
  },

  // Inline workers for library build so consumers don't need to handle worker files
  worker: {
    format: 'es',
  },

  build: {
    // Keep the ES2020 baseline (matches tsconfig) rather than Vite 8's newer default target
    target: 'es2020',
    lib: {
      entry: resolve(import.meta.dirname, 'index.ts'),
      name: 'WebLivePlayer',
      formats: ['es', 'cjs'],
      fileName: (format) => `web-live-player.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: [
        'stinky-moq-js',
        'mp4box',
        'tinyh264',
        '@stinkycomputing/sesame-api-client',
      ],
      output: {
        globals: {
          'stinky-moq-js': 'StinkyMoqJS',
          'mp4box': 'MP4Box',
          'tinyh264': 'TinyH264',
          '@stinkycomputing/sesame-api-client': 'SesameApiClient',
        },
      },
    },
  },
  plugins: [
    workletSource(),
    dts({
      include: ['./**/*.ts'],
      exclude: ['./demo/**/*', './**/*.test.ts', './vitest.config.ts', './vite-plugin-worklet.ts', './tmp/**/*'],
    }),
  ],
});
