import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * Forward-only SQL migrations.
 *
 * Each file is sent as a single simple-protocol query, which Postgres executes
 * in one implicit transaction -- so a migration either applies completely or
 * not at all. The bookkeeping INSERT is appended to that same query so the
 * ledger can never disagree with the schema.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  await ensureLedger(sql);

  const files = await readMigrations(dir);
  const existing = await sql<{ name: string; checksum: string }[]>`
    SELECT name, checksum FROM schema_migrations
  `;
  const applied = new Map(existing.map((r) => [r.name, r.checksum]));

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const file of files) {
    const prior = applied.get(file.name);
    if (prior) {
      if (prior !== file.checksum) {
        throw new Error(
          `Migration ${file.name} has changed since it was applied ` +
            `(recorded ${prior.slice(0, 12)}, found ${file.checksum.slice(0, 12)}). ` +
            'Migrations are immutable; add a new file instead.',
        );
      }
      result.skipped.push(file.name);
      continue;
    }

    const started = Date.now();
    const bookkeeping = `
      INSERT INTO schema_migrations (name, checksum, duration_ms)
      VALUES (${literal(file.name)}, ${literal(file.checksum)}, 0);
    `;

    await sql.unsafe(`${file.sql}\n${bookkeeping}`).simple();

    const durationMs = Date.now() - started;
    await sql`
      UPDATE schema_migrations SET duration_ms = ${durationMs} WHERE name = ${file.name}
    `;

    logger.info({ event: 'migration_applied', migration: file.name, durationMs }, 'migration applied');
    result.applied.push(file.name);
  }

  return result;
}

/** Single-quoted SQL literal. Only ever used with our own migration filenames. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
