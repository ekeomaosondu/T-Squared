import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `__dirname` is not defined when Vitest loads this config as ESM.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Structured logs are verified by their own assertions, not by eyeballing
    // test output.
    env: { LOG_LEVEL: 'silent', LOG_PRETTY: 'false' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // Mirrors the "@/*" -> "./*" mapping in tsconfig.json.
    alias: { '@': rootDir },
  },
});
