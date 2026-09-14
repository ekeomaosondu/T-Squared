import type { ResearchEvent } from '@/src/research/events/researchEvent';

/**
 * Where a backtest gets its events.
 *
 * Deliberately narrow. A live feed will implement the same shape with an
 * unbounded iterable, which is what lets the engine, the strategies and the
 * metrics run unchanged against Kalshi in Phase 2.
 */
export interface HistoricalRequest {
  datasetId: string;

  seriesTickers?: string[];
  eventTickers?: string[];
  marketTickers?: string[];

  startTime: Date;
  endTime: Date;

  includeTrades?: boolean;
  includeLifecycle?: boolean;
}

/**
 * What the source knows about the data it is about to return, established
 * BEFORE any event is emitted.
 *
 * A run is only reproducible if the exact bytes it read are identified, so the
 * fingerprint covers the object list and its sizes rather than merely the
 * request.
 */
export interface DatasetSlice {
  datasetId: string;
  /** Stable hash of the object paths and physical shape actually scanned. */
  fingerprint: string;
  objects: { path: string; rows: number; rowGroups: number }[];
  rowCounts: Record<string, number>;
  /** Earliest and latest receive time present, or null when the slice is empty. */
  firstReceiveMs: bigint | null;
  lastReceiveMs: bigint | null;
  marketTickers: string[];
  seriesTickers: string[];
  /** Capture gaps overlapping the window. Always surfaced, never filtered. */
  captureGaps: {
    gapId: string;
    startedAtMs: bigint;
    endedAtMs: bigint | null;
    reason: string;
    affectedMarkets: string[];
  }[];
}

/**
 * A book state the COLLECTOR recorded independently, used to check that a
 * replay reconstructs the same book rather than merely a plausible one.
 *
 * These come from the recorder's own periodic sampling of the book it was
 * maintaining live. They are deliberately NOT part of the event stream: they
 * are derived state, and feeding them back in would make the replay reseed
 * itself from its own answer and turn the check into a tautology.
 */
export interface BookCheckpoint {
  marketTicker: string;
  atMs: bigint;
  stateHash: string;
}

export interface HistoricalDataSource {
  readonly kind: string;
  /** Resolves what will be read, without reading it. */
  describe(request: HistoricalRequest): Promise<DatasetSlice>;
  stream(request: HistoricalRequest): AsyncIterable<ResearchEvent>;
  /** Independently recorded book hashes, in time order. */
  checkpoints(request: HistoricalRequest): Promise<BookCheckpoint[]>;
  close(): Promise<void>;
}
