import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'demo'),
  base: './',
  
  // Handle tinyh264's .asset files as URLs
  assetsInclude: ['**/*.asset'],
  
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
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
    outDir: resolve(__dirname, 'dist-demo'),
    emptyOutDir: true,
  },
  
  // Library build configuration
  // Use `npm run build:lib` to build the library
});
