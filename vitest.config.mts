import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // Fixture repos are built with real git, which is slow on Windows when suites run in parallel.
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
  },
});
