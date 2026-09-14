import { env } from '@/src/config/env';
import { DuckDBHistoricalDataSource } from '@/src/research/data/duckdbSource';

/**
 * The research lake, configured from the environment.
 *
 * Research reads the SAME R2 bucket the collector writes, with the same
 * credentials, so there is no second copy of the data and no possibility of a
 * study running against a stale export.
 */
export function openLake(): DuckDBHistoricalDataSource {
  const e = env();
  if (!e.ARCHIVE_BUCKET || !e.ARCHIVE_ACCESS_KEY_ID || !e.ARCHIVE_SECRET_ACCESS_KEY) {
    throw new Error(
      'the research lake needs ARCHIVE_BUCKET, ARCHIVE_ENDPOINT, ARCHIVE_ACCESS_KEY_ID and ' +
        'ARCHIVE_SECRET_ACCESS_KEY -- the same credentials the collector archives with.',
    );
  }
  return new DuckDBHistoricalDataSource({
    bucket: e.ARCHIVE_BUCKET,
    endpoint: e.ARCHIVE_ENDPOINT,
    accessKeyId: e.ARCHIVE_ACCESS_KEY_ID,
    secretAccessKey: e.ARCHIVE_SECRET_ACCESS_KEY,
    region: e.ARCHIVE_REGION,
  });
}
