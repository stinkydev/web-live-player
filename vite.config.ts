import { defineConfig } from 'vite';
import { resolve } from 'path';
import { workletSource } from './vite-plugin-worklet.ts';

export default defineConfig({
  root: resolve(import.meta.dirname, 'demo'),
  base: './',

  plugins: [workletSource()],
  
  // Handle tinyh264's .asset files as URLs
  assetsInclude: ['**/*.asset'],
  
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '.'),
    },
  },
  
  server: {
    port: 3001,
    host: '0.0.0.0',
    proxy: {
      // Proxy MoQ relay connections if needed
      '/moq': {
        target: 'https://localhost:4443',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  
  build: {
    outDir: resolve(import.meta.dirname, 'dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'demo/index.html'),
        player: resolve(import.meta.dirname, 'demo/player/index.html'),
        capture: resolve(import.meta.dirname, 'demo/capture/index.html'),
        chat: resolve(import.meta.dirname, 'demo/chat/index.html'),
        sync: resolve(import.meta.dirname, 'demo/sync/index.html'),
      },
    },
  },
  
  // Library build configuration
  // Use `npm run build:lib` to build the library
});
