import type { Sql } from '@/src/persistence/db';
import type { Decimal } from '@/src/book/decimal';
import type { CalibrationEnvelope } from '@/src/research/calibration/riskEnvelope';

/**
 * Persistence for calibration.
 *
 * Written as the run proceeds rather than at the end. A calibration run holds
 * real orders; if the process dies, the probes it placed still exist on the
 * exchange, and a record that only materialised on a clean exit would leave
 * nothing to reconcile against.
 */

const n = (v: Decimal | null | undefined) => (v === null || v === undefined ? null : v.toFixed(6));
const b = (v: bigint | number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

export interface ProbeInsert {
  probeId: string;
  runId: string;
  marketTicker: string;
  seriesTicker: string | null;
  eventTicker: string | null;
  depthStratum: string;
  flowStratum: string;
  probeSide: 'bid' | 'ask';
  plannedDwellMs: number;
  decisionTsMs: number;
  bookHashAtDecision: string | null;
  bookSeqAtDecision: bigint | null;
  decisionBid: Decimal | null;
  decisionAsk: Decimal | null;
  decisionBidSize: Decimal | null;
  decisionAskSize: Decimal | null;
  decisionMid: Decimal | null;
  decisionImbalance1: Decimal | null;
  decisionImbalance3: Decimal | null;
  displayedSizeAtEntry: Decimal | null;
  clientOrderId: string;
  orderSide: 'yes' | 'no';
  orderAction: 'buy' | 'sell';
  priceCents: number;
  yesPrice: Decimal;
  quantity: number;
  expirationTs: number | null;
}

export class CalibrationStore {
  constructor(private readonly sql: Sql) {}

  async startRun(args: {
    runId: string;
    datasetId: string;
    kalshiEnv: string;
    gitCommitSha: string | null;
    envelope: CalibrationEnvelope;
    orderGroupId: string | null;
  }): Promise<void> {
    await this.sql`
      INSERT INTO calibration_runs (
        run_id, dataset_id, started_at, kalshi_env, git_commit_sha, envelope, order_group_id
      ) VALUES (
        ${args.runId}, ${args.datasetId}, now(), ${args.kalshiEnv}, ${args.gitCommitSha},
        ${this.sql.json(args.envelope as never)}, ${args.orderGroupId}
      )
    `;
  }

  async endRun(runId: string, reason: string, detail: string | null): Promise<void> {
    await this.sql`
      UPDATE calibration_runs
         SET ended_at = now(), end_reason = ${reason}, end_detail = ${detail}
       WHERE run_id = ${runId}
    `;
  }

  async bumpRunCounters(
    runId: string,
    delta: { attempted?: number; placed?: number; filled?: number; contracts?: number },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_runs
         SET probes_attempted = probes_attempted + ${delta.attempted ?? 0},
             probes_placed    = probes_placed    + ${delta.placed ?? 0},
             probes_filled    = probes_filled    + ${delta.filled ?? 0},
             contracts_filled = contracts_filled + ${delta.contracts ?? 0}
       WHERE run_id = ${runId}
    `;
  }

  /**
   * Records the probe BEFORE the order is sent.
   *
   * The row exists first on purpose: if the create then times out, there is
   * already a durable record naming the client_order_id we may have live on
   * the exchange. Writing after the fact would lose exactly the case that
   * needs reconciling.
   */
  async insertProbe(p: ProbeInsert): Promise<void> {
    await this.sql`
      INSERT INTO calibration_probes (
        probe_id, run_id, market_ticker, series_ticker, event_ticker,
        depth_stratum, flow_stratum, probe_side, planned_dwell_ms,
        decision_ts, decision_ts_ms, book_seq_at_decision, book_hash_at_decision,
        decision_bid, decision_ask, decision_bid_size, decision_ask_size,
        decision_mid, decision_imbalance_1, decision_imbalance_3,
        displayed_size_at_entry,
        client_order_id, order_side, order_action, price_cents, yes_price, quantity,
        expiration_ts, terminal_state
      ) VALUES (
        ${p.probeId}, ${p.runId}, ${p.marketTicker}, ${p.seriesTicker}, ${p.eventTicker},
        ${p.depthStratum}, ${p.flowStratum}, ${p.probeSide}, ${p.plannedDwellMs},
        to_timestamp(${p.decisionTsMs} / 1000.0), ${p.decisionTsMs},
        ${p.bookSeqAtDecision === null ? null : p.bookSeqAtDecision.toString()},
        ${p.bookHashAtDecision},
        ${n(p.decisionBid)}, ${n(p.decisionAsk)}, ${n(p.decisionBidSize)}, ${n(p.decisionAskSize)},
        ${n(p.decisionMid)}, ${n(p.decisionImbalance1)}, ${n(p.decisionImbalance3)},
        ${n(p.displayedSizeAtEntry)},
        ${p.clientOrderId}, ${p.orderSide}, ${p.orderAction}, ${p.priceCents},
        ${p.yesPrice.toFixed(6)}, ${p.quantity}, ${p.expirationTs}, 'pending'
      )
    `;
  }

  async recordSubmission(
    probeId: string,
    args: {
      orderId: string | null;
      httpSendTsMs: number | null;
      httpAckTsMs: number | null;
      httpStatus: number | null;
      terminalState: string | null;
      rejectReason: string | null;
    },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET order_id          = ${args.orderId},
             http_send_ts_ms   = ${args.httpSendTsMs},
             http_ack_ts_ms    = ${args.httpAckTsMs},
             submit_latency_ms = ${
               args.httpSendTsMs !== null && args.httpAckTsMs !== null
                 ? args.httpAckTsMs - args.httpSendTsMs
                 : null
             },
             http_status       = ${args.httpStatus},
             terminal_state    = coalesce(${args.terminalState}, terminal_state),
             reject_reason     = ${args.rejectReason}
       WHERE probe_id = ${probeId}
    `;
  }

  async recordPrivateAck(probeId: string, atMs: number): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET private_ack_ts_ms = coalesce(private_ack_ts_ms, ${atMs})
       WHERE probe_id = ${probeId}
    `;
  }

  async recordInitialQueue(
    probeId: string,
    args: { queuePosition: number | null; sendTsMs: number; recvTsMs: number },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET initial_queue_position   = ${args.queuePosition},
             initial_queue_send_ts_ms = ${args.sendTsMs},
             initial_queue_recv_ts_ms = ${args.recvTsMs}
       WHERE probe_id = ${probeId} AND initial_queue_position IS NULL
    `;
  }

  async recordCancel(
    probeId: string,
    args: { decisionTsMs: number; sendTsMs: number | null; ackTsMs: number | null },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET cancel_decision_ts_ms = ${args.decisionTsMs},
             cancel_send_ts_ms     = ${args.sendTsMs},
             cancel_ack_ts_ms      = ${args.ackTsMs},
             cancel_latency_ms     = ${
               args.sendTsMs !== null && args.ackTsMs !== null ? args.ackTsMs - args.sendTsMs : null
             }
       WHERE probe_id = ${probeId}
    `;
  }

  async recordFill(
    probeId: string,
    args: {
      exchangeTsMs: number | null;
      receiveTsMs: number;
      price: string | null;
      quantity: string | null;
      feeDollars: string | null;
      queueBefore: number | null;
    },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET fill_exchange_ts_ms = ${args.exchangeTsMs},
             fill_receive_ts_ms  = ${args.receiveTsMs},
             fill_price          = ${args.price},
             fill_quantity       = ${args.quantity},
             fill_fee            = ${args.feeDollars},
             fill_queue_before   = ${args.queueBefore},
             terminal_state      = 'filled',
             terminal_at         = now(),
             censored            = false
       WHERE probe_id = ${probeId}
    `;
  }

  async finishProbe(
    probeId: string,
    args: { terminalState: string; censored: boolean; notes?: string },
  ): Promise<void> {
    await this.sql`
      UPDATE calibration_probes
         SET terminal_state = ${args.terminalState},
             terminal_at    = now(),
             censored       = ${args.censored},
             notes          = coalesce(notes || ' | ', '') || ${args.notes ?? ''}
       WHERE probe_id = ${probeId} AND terminal_state NOT IN ('filled')
    `;
  }

  async insertQueueObservation(args: {
    probeId: string;
    seqNo: number;
    pollSendTsMs: number;
    pollReceiveTsMs: number;
    timeSinceEntryMs: number;
    queuePosition: number | null;
    displayedLevelSize: Decimal | null;
    bestBid: Decimal | null;
    bestAsk: Decimal | null;
    bestBidSize: Decimal | null;
    bestAskSize: Decimal | null;
    imbalance1: Decimal | null;
    imbalance3: Decimal | null;
    cumExecuted: Decimal;
    cumRemoved: Decimal;
    cumAdded: Decimal;
    cumTrades: number;
  }): Promise<void> {
    await this.sql`
      INSERT INTO calibration_queue_observations (
        probe_id, seq_no, poll_send_ts_ms, poll_receive_ts_ms, time_since_entry_ms,
        queue_position, displayed_level_size, best_bid, best_ask,
        best_bid_size, best_ask_size, imbalance_1, imbalance_3,
        cum_executed_at_price, cum_removed_at_price, cum_added_at_price, cum_trades_at_price
      ) VALUES (
        ${args.probeId}, ${args.seqNo}, ${args.pollSendTsMs}, ${args.pollReceiveTsMs},
        ${args.timeSinceEntryMs}, ${args.queuePosition}, ${n(args.displayedLevelSize)},
        ${n(args.bestBid)}, ${n(args.bestAsk)}, ${n(args.bestBidSize)}, ${n(args.bestAskSize)},
        ${n(args.imbalance1)}, ${n(args.imbalance3)},
        ${args.cumExecuted.toFixed(6)}, ${args.cumRemoved.toFixed(6)},
        ${args.cumAdded.toFixed(6)}, ${args.cumTrades}
      )
      ON CONFLICT (probe_id, seq_no) DO NOTHING
    `;
  }

  async insertCounterfactual(args: {
    probeId: string;
    fillModel: string;
    parameters: Record<string, unknown>;
    wouldFill: boolean;
    fillTimeMs: number | null;
    fillReason: string | null;
    queueAtEntry: Decimal | null;
    queueBeforeFill: Decimal | null;
  }): Promise<void> {
    await this.sql`
      INSERT INTO calibration_counterfactuals (
        probe_id, fill_model, fill_model_parameters, would_fill, fill_time_ms,
        fill_reason, modelled_queue_at_entry, modelled_queue_before_fill
      ) VALUES (
        ${args.probeId}, ${args.fillModel}, ${this.sql.json(args.parameters as never)},
        ${args.wouldFill}, ${b(args.fillTimeMs)}, ${args.fillReason},
        ${n(args.queueAtEntry)}, ${n(args.queueBeforeFill)}
      )
      ON CONFLICT (probe_id, fill_model) DO NOTHING
    `;
  }

  async event(args: {
    runId: string;
    kind: string;
    reason: string;
    marketTicker?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      INSERT INTO calibration_events (run_id, kind, reason, market_ticker, detail)
      VALUES (
        ${args.runId}, ${args.kind}, ${args.reason}, ${args.marketTicker ?? null},
        ${args.detail ? this.sql.json(args.detail as never) : null}
      )
    `;
  }
}
