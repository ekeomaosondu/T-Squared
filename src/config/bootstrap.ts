import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

/**
 * Loads .env files for plain Node entrypoints (scripts, daemon), matching the
 * precedence Next.js applies automatically inside the app. Import this FIRST
 * in any script, before anything that reads the environment.
 *
 * Earlier files win; dotenv never overwrites an already-set variable, so real
 * process environment (Vercel, CI, shell) always takes precedence over files.
 */
const FILES = ['.env.local', '.env'];

let loaded = false;

export function loadDotEnv(cwd = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  for (const file of FILES) {
    const p = path.join(cwd, file);
    if (existsSync(p)) dotenv.config({ path: p, override: false, quiet: true });
  }
}

loadDotEnv();
