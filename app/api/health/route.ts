import { NextResponse } from 'next/server';
import { env } from '@/src/config/env';
import { datasetHealth, DEFAULT_THRESHOLDS } from '@/src/integrity/datasetHealth';
import { db } from '@/src/persistence/db';

/**
 * Single dataset-health endpoint.
 *
 * One thing to alert on rather than twenty metrics. HTTP status mirrors the
 * level so a plain uptime check is meaningful without parsing the body:
 *
 *   200  HEALTHY
 *   200  DEGRADED  (needs attention; history is still being captured)
 *   503  CRITICAL  (dataset is being damaged or is not being collected)
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const e = env();
    const health = await datasetHealth(db(), {
      ...DEFAULT_THRESHOLDS,
      heartbeatStaleMs: e.COLLECTOR_HEARTBEAT_STALE_MS,
      retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
    });

    return NextResponse.json(health, { status: health.level === 'CRITICAL' ? 503 : 200 });
  } catch (err) {
    // An unreachable database is itself critical: nothing is being recorded.
    return NextResponse.json(
      {
        level: 'CRITICAL',
        checkedAt: new Date().toISOString(),
        critical: [`health check failed: ${err instanceof Error ? err.message : String(err)}`],
        degraded: [],
        checks: [],
      },
      { status: 503 },
    );
  }
}
