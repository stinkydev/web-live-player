import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // Handle tinyh264's .asset files as URLs
  assetsInclude: ['**/*.asset'],
  
  // Inline workers for library build so consumers don't need to handle worker files
  worker: {
    format: 'es',
  },
  
  build: {
    lib: {
      entry: resolve(__dirname, 'index.ts'),
      name: 'WebLivePlayer',
      formats: ['es', 'cjs'],
      fileName: (format) => `web-live-player.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['stinky-moq-js'],
      output: {
        globals: {
          'stinky-moq-js': 'StinkyMoqJS',
        },
      },
    },
  },
  plugins: [
    dts({
      include: ['./**/*.ts'],
      exclude: ['./demo/**/*', './**/*.test.ts', './vitest.config.ts'],
    }),
  ],
});
