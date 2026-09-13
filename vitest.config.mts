import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `__dirname` is not defined when Vitest loads this config as ESM.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // Mirrors the "@/*" -> "./*" mapping in tsconfig.json.
    alias: { '@': rootDir },
  },
});
