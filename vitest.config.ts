import { defineConfig } from 'vitest/config';
import { workletSource } from './vite-plugin-worklet';

export default defineConfig({
  plugins: [workletSource()],
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
