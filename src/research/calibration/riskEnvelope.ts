import { Decimal, D, ZERO, type DecimalInput } from '@/src/book/decimal';

/**
 * What the calibration experiment is allowed to do with real money.
 *
 * The envelope is deliberately far smaller than anything that could matter
 * financially, because the experiment is not trying to make money -- it is
 * buying information about queue mechanics, and one contract carries almost
 * all of it. Size becomes interesting only for partial fills and market
 * impact, which are later questions.
 *
 * Every check is a pure function of observed state so it can be exercised
 * without an exchange. The runner asks permission before every action and
 * stops on refusal; there is no path that places an order without passing
 * through here.
 *
 * ---------------------------------------------------------------------------
 * On breaching a limit
 * ---------------------------------------------------------------------------
 * A breach stops NEW probes. It does not cross the spread to flatten.
 * Aggressively unwinding a one-contract position would pay the spread to
 * remove an exposure smaller than the spread, and -- worse -- would make the
 * experiment's own behaviour depend on its inventory, contaminating the very
 * measurements it exists to take.
 */

export interface CalibrationEnvelope {
  /** Contracts per probe. One. See the file comment. */
  orderSize: number;
  /** Resting probes across the whole account. */
  maxRestingOrders: number;
  maxRestingPerMarket: number;
  maxPositionPerMarket: number;
  /** Hard kill: worst-case dollars at risk across positions and resting orders. */
  maxWorstCaseExposureUsd: DecimalInput;
  /** Rolling contract limit handed to the exchange as a runaway guard. */
  orderGroup15sLimit: number;
  maxFillsPerDay: number;
  maxNewOrdersPerDay: number;
  /** Simultaneous probes per series, so NY and LAX stay independent. */
  maxProbesPerSeries: number;
  /** Prices outside this band are not probed: the tails behave differently. */
  minMid: DecimalInput;
  maxMid: DecimalInput;
  /** Do not probe a market this close to its expected close. */
  minMsToClose: number;
}

export const CALIBRATION_V0: CalibrationEnvelope = {
  orderSize: 1,
  maxRestingOrders: 2,
  maxRestingPerMarket: 1,
  maxPositionPerMarket: 1,
  maxWorstCaseExposureUsd: '5',
  orderGroup15sLimit: 2,
  maxFillsPerDay: 50,
  maxNewOrdersPerDay: 200,
  maxProbesPerSeries: 1,
  minMid: '0.15',
  maxMid: '0.85',
  minMsToClose: 30 * 60_000,
};

/** Everything the envelope needs to know about the account right now. */
export interface AccountState {
  /** Resting probes, by market. */
  restingByMarket: ReadonlyMap<string, number>;
  /** Signed contract position, by market. */
  positionByMarket: ReadonlyMap<string, Decimal>;
  /**
   * Premium at risk per open position, by market.
   *
   * For a binary contract the worst case is losing the premium paid: a YES
   * bought at 0.40 can go to zero, and a NO bought at 0.60 likewise. There is
   * no unbounded downside, which is what makes a five-dollar cap meaningful
   * rather than notional.
   */
  premiumAtRiskByMarket: ReadonlyMap<string, Decimal>;
  probesInFlight: ReadonlyMap<string, number>;
  seriesInFlight: ReadonlyMap<string, number>;
  fillsToday: number;
  ordersToday: number;
}

export type BlockReason =
  | 'max_resting_orders'
  | 'max_resting_per_market'
  | 'max_position_per_market'
  | 'max_worst_case_exposure'
  | 'max_fills_per_day'
  | 'max_new_orders_per_day'
  | 'max_probes_per_series'
  | 'probe_already_in_flight';

export interface EnvelopeDecision {
  allowed: boolean;
  reason?: BlockReason;
  detail?: string;
}

const ALLOW: EnvelopeDecision = { allowed: true };

/**
 * Worst-case dollars at risk if every resting order filled.
 *
 * Counts resting orders as though they were already filled. A resting order is
 * a commitment: by the time it fills there is no opportunity to decline, so
 * counting exposure only after the fact would let the account exceed the cap
 * for exactly as long as it takes to be filled.
 */
export function worstCaseExposure(
  state: AccountState,
  pendingPremium: Decimal = ZERO,
): Decimal {
  let total = pendingPremium;
  for (const premium of state.premiumAtRiskByMarket.values()) total = total.plus(premium);
  return total;
}

/**
 * May we place one more probe in this market?
 *
 * @param premiumIfFilled worst-case dollars this probe would add
 */
export function mayPlaceProbe(
  envelope: CalibrationEnvelope,
  state: AccountState,
  marketTicker: string,
  seriesTicker: string,
  premiumIfFilled: Decimal,
): EnvelopeDecision {
  const restingTotal = [...state.restingByMarket.values()].reduce((n, v) => n + v, 0);
  const inFlightTotal = [...state.probesInFlight.values()].reduce((n, v) => n + v, 0);

  if (state.probesInFlight.get(marketTicker)) {
    return { allowed: false, reason: 'probe_already_in_flight', detail: marketTicker };
  }
  if (restingTotal + inFlightTotal >= envelope.maxRestingOrders) {
    return {
      allowed: false,
      reason: 'max_resting_orders',
      detail: `${restingTotal} resting + ${inFlightTotal} in flight >= ${envelope.maxRestingOrders}`,
    };
  }
  if ((state.restingByMarket.get(marketTicker) ?? 0) >= envelope.maxRestingPerMarket) {
    return { allowed: false, reason: 'max_resting_per_market', detail: marketTicker };
  }
  if ((state.seriesInFlight.get(seriesTicker) ?? 0) >= envelope.maxProbesPerSeries) {
    return { allowed: false, reason: 'max_probes_per_series', detail: seriesTicker };
  }

  // Checked against the position this probe WOULD create, not the one it
  // finds. Kalshi fills fractionally: a probe that filled 0.85 leaves a
  // position under a one-contract limit, which used to let another probe in,
  // whose full fill then took the market to 1.85 and tripped the kill switch.
  // The kill switch was right to fire; this check should have made it
  // unnecessary.
  const position = state.positionByMarket.get(marketTicker) ?? ZERO;
  const worstCasePosition = position.abs().plus(envelope.orderSize);
  if (worstCasePosition.gt(envelope.maxPositionPerMarket)) {
    return {
      allowed: false,
      reason: 'max_position_per_market',
      detail:
        `${marketTicker} holds ${position.toString()}; another ` +
        `${envelope.orderSize} would reach ${worstCasePosition.toString()}`,
    };
  }

  const exposure = worstCaseExposure(state, premiumIfFilled);
  if (exposure.gt(D(envelope.maxWorstCaseExposureUsd))) {
    return {
      allowed: false,
      reason: 'max_worst_case_exposure',
      detail: `$${exposure.toFixed(2)} > $${D(envelope.maxWorstCaseExposureUsd).toFixed(2)}`,
    };
  }

  if (state.fillsToday >= envelope.maxFillsPerDay) {
    return {
      allowed: false,
      reason: 'max_fills_per_day',
      detail: `${state.fillsToday} >= ${envelope.maxFillsPerDay}`,
    };
  }
  if (state.ordersToday >= envelope.maxNewOrdersPerDay) {
    return {
      allowed: false,
      reason: 'max_new_orders_per_day',
      detail: `${state.ordersToday} >= ${envelope.maxNewOrdersPerDay}`,
    };
  }

  return ALLOW;
}

/**
 * Has the account exceeded its hard cap?
 *
 * Separate from {@link mayPlaceProbe} because it is a KILL rather than a
 * refusal: the run ends, cancels what it can and stops, instead of waiting for
 * conditions to improve.
 */
export function isKilled(
  envelope: CalibrationEnvelope,
  state: AccountState,
): { killed: boolean; detail?: string } {
  const exposure = worstCaseExposure(state);
  const cap = D(envelope.maxWorstCaseExposureUsd);
  if (exposure.gt(cap)) {
    return {
      killed: true,
      detail: `worst-case exposure $${exposure.toFixed(2)} exceeds the $${cap.toFixed(2)} cap`,
    };
  }
  for (const [market, position] of state.positionByMarket) {
    if (position.abs().gt(envelope.maxPositionPerMarket)) {
      return {
        killed: true,
        detail: `${market} holds ${position.toString()}, over the ${envelope.maxPositionPerMarket}-contract limit`,
      };
    }
  }
  return { killed: false };
}

/**
 * Worst-case dollars for one contract at a YES-terms price on a given side.
 *
 * Buying YES at p risks p. Buying NO at 1-p risks 1-p. Both are the premium
 * paid, and both are bounded, which is the property that makes this experiment
 * safe at all.
 */
export function premiumForProbe(yesPrice: Decimal, side: 'bid' | 'ask', contracts: number): Decimal {
  const perContract = side === 'bid' ? yesPrice : D(1).minus(yesPrice);
  return perContract.mul(contracts);
}
