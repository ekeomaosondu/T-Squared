import { z } from 'zod';
import { Decimal } from '@/src/book/decimal';

/**
 * The part of the fee treatment the exchange does not tell us.
 *
 * Kalshi's API reports, per series, a fee TYPE and a fee MULTIPLIER. It does
 * not report the coefficient inside the formula, and it does not report
 * whether a series charges a maker fee. Those live in a published schedule
 * that a human has to read.
 *
 * Keeping them in a config file with a source, a date and an explicit
 * `verified` flag makes the human step visible. A constant in the engine gets
 * copied forward for years and nobody ever asks where it came from.
 */

const DecimalString = z.string().refine((v) => {
  try {
    return new Decimal(v).isFinite();
  } catch {
    return false;
  }
}, 'must be a finite decimal string');

const FeeScheduleEntry = z.object({
  feeType: z.string(),
  baseRate: DecimalString,
  makerFeePerContract: DecimalString,
  roundUpToCents: z.boolean(),
  effectiveFrom: z.string(),
  source: z.string(),
  verified: z.boolean(),
  verifiedBy: z.string().nullable().default(null),
  verifiedAt: z.string().nullable().default(null),
  notes: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * A market-maker programme rebate.
 *
 * Deliberately separate from the schedule. A rebate is a property of the
 * PARTICIPANT, not of the market, so folding it into the fee would make
 * ordinary-member economics and market-maker economics indistinguishable in
 * the output -- and the second is a much stronger claim than the first.
 */
const MakerRebate = z.object({
  programme: z.string(),
  perContract: DecimalString,
  source: z.string(),
  effectiveFrom: z.string(),
  verified: z.boolean(),
});

export const FeeScheduleFile = z.object({
  schedules: z.array(FeeScheduleEntry),
  makerRebate: MakerRebate.nullable().default(null),
});

export type FeeScheduleEntry = z.infer<typeof FeeScheduleEntry>;
export type MakerRebate = z.infer<typeof MakerRebate>;
export type FeeScheduleFile = z.infer<typeof FeeScheduleFile>;

export const DEFAULT_FEE_SCHEDULE_PATH = 'config/feeSchedule.json';

export function parseFeeSchedule(raw: unknown): FeeScheduleFile {
  const parsed = FeeScheduleFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid fee schedule: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

export async function loadFeeSchedule(
  filePath: string = DEFAULT_FEE_SCHEDULE_PATH,
): Promise<FeeScheduleFile> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return parseFeeSchedule(JSON.parse(await readFile(resolved, 'utf8')));
}

/**
 * The entry in force for a fee type at an instant.
 *
 * Entries are matched by type and by `effectiveFrom`, so a schedule change is
 * recorded as a new entry rather than by editing the old one -- otherwise
 * re-running last month's backtest silently applies this month's fees.
 */
export function scheduleFor(
  file: FeeScheduleFile,
  feeType: string | null,
  atMs: bigint | null,
): FeeScheduleEntry | null {
  if (feeType === null) return null;
  const at = atMs === null ? Number.MAX_SAFE_INTEGER : Number(atMs);

  const candidates = file.schedules
    .filter((s) => s.feeType === feeType)
    .filter((s) => Date.parse(s.effectiveFrom) <= at)
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));

  return candidates[0] ?? null;
}
