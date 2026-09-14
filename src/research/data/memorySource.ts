import { fingerprintObjects } from '@/src/research/data/datasetManifest';
import type {
  BookCheckpoint,
  DatasetSlice,
  HistoricalDataSource,
  HistoricalRequest,
} from '@/src/research/data/historicalDataSource';
import { isMarketEvent, type ResearchEvent } from '@/src/research/events/researchEvent';

/**
 * A data source backed by an in-memory event list.
 *
 * This is the reference implementation of {@link HistoricalDataSource}: small
 * enough to read in one sitting, and it makes the engine testable without R2,
 * DuckDB or credentials. Tests that construct exact event sequences -- a gap
 * followed by a recovery snapshot, a trade at a known queue position -- are the
 * only way to assert behaviour that today's recorded data happens not to
 * contain.
 *
 * It does NOT reorder. Whatever order the caller supplies is the order the
 * engine sees, which is what lets a test feed a deliberately bad ordering and
 * assert that the engine notices rather than silently absorbing it.
 */
export class MemoryHistoricalDataSource implements HistoricalDataSource {
  readonly kind = 'memory';

  constructor(
    private readonly events: readonly ResearchEvent[],
    private readonly bookCheckpoints: readonly BookCheckpoint[] = [],
  ) {}

  private inWindow(event: ResearchEvent, req: HistoricalRequest): boolean {
    const t = Number(event.receiveTimeMs);
    if (t < req.startTime.getTime() || t >= req.endTime.getTime()) return false;
    if (req.marketTickers?.length && isMarketEvent(event)) {
      if (!req.marketTickers.includes(event.marketTicker)) return false;
    }
    if (req.seriesTickers?.length && event.seriesTicker) {
      if (!req.seriesTickers.includes(event.seriesTicker)) return false;
    }
    return true;
  }

  async describe(req: HistoricalRequest): Promise<DatasetSlice> {
    const selected = this.events.filter((e) => this.inWindow(e, req));
    const markets = [...new Set(selected.filter(isMarketEvent).map((e) => e.marketTicker))].sort();
    const series = [
      ...new Set(selected.map((e) => e.seriesTicker).filter((s): s is string => !!s)),
    ].sort();

    const objects = [{ path: 'memory://events', rows: selected.length, rowGroups: 1 }];

    return {
      datasetId: req.datasetId,
      fingerprint: fingerprintObjects(objects),
      objects,
      rowCounts: { events: selected.length },
      firstReceiveMs: selected[0]?.receiveTimeMs ?? null,
      lastReceiveMs: selected[selected.length - 1]?.receiveTimeMs ?? null,
      marketTickers: markets,
      seriesTickers: series,
      captureGaps: selected
        .filter((e): e is Extract<ResearchEvent, { kind: 'capture_gap' }> => e.kind === 'capture_gap')
        .map((e) => ({
          gapId: e.gapId,
          startedAtMs: e.startedAtMs,
          endedAtMs: e.endedAtMs,
          reason: e.reason,
          affectedMarkets: [...e.affectedMarkets],
        })),
    };
  }

  async *stream(req: HistoricalRequest): AsyncIterable<ResearchEvent> {
    for (const event of this.events) {
      if (this.inWindow(event, req)) yield event;
    }
  }

  async checkpoints(_req: HistoricalRequest): Promise<BookCheckpoint[]> {
    return [...this.bookCheckpoints];
  }

  async close(): Promise<void> {}
}
