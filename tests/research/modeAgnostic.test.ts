import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The non-negotiable architectural rule, enforced statically.
 *
 * Strategy code must not be able to tell whether it is running in BACKTEST,
 * SHADOW, PAPER or LIVE. A single `import { SimulatedExchange }` in a strategy
 * would compile, pass every behavioural test, and quietly make that strategy
 * impossible to promote to live trading -- which is the entire point of the
 * platform. So the rule is checked the only way it can be: by reading the
 * source.
 *
 * The same scan enforces determinism at its root. `Date.now`, `setTimeout` and
 * `Math.random` cannot appear in a backtest's execution path, because each of
 * them makes a rerun differ from the run it is supposed to reproduce.
 */

const ROOT = path.join(process.cwd(), 'src', 'research');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(process.cwd(), f);

/** Directories a strategy author writes in. */
const STRATEGY_DIRS = [path.join(ROOT, 'strategy'), path.join(ROOT, 'strategies')];

/** Modules that would reveal the execution venue. */
const VENUE_MODULES = [
  'execution/simulatedExchange',
  'engine/backtestEngine',
  'engine/runBacktest',
  'data/duckdbSource',
  'data/memorySource',
  'data/lakeSource',
  'results/resultWriter',
  'persistence/db',
];

describe('strategy code is mode-agnostic', () => {
  it('never imports the simulator, the engine or a data source', () => {
    const violations: string[] = [];
    for (const dir of STRATEGY_DIRS) {
      for (const file of filesUnder(dir)) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of VENUE_MODULES) {
          if (source.includes(forbidden)) violations.push(`${rel(file)} imports ${forbidden}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never mentions a specific execution mode', () => {
    // A strategy may read ctx.mode for logging, but it must not branch on a
    // literal: `if (mode === 'backtest')` is the exact divergence between the
    // version that was tested and the version that trades.
    const violations: string[] = [];
    for (const dir of STRATEGY_DIRS) {
      for (const file of filesUnder(dir)) {
        const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        for (const mode of ['backtest', 'shadow', 'calibration', 'live']) {
          if (new RegExp(`['"\`]${mode}['"\`]`).test(source)) {
            violations.push(`${rel(file)} branches on the literal "${mode}"`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('the simulation is deterministic by construction', () => {
  const EXEMPT = new Set([
    // Measures its own runtime; explicitly excluded from result comparison.
    path.join(ROOT, 'engine', 'backtestEngine.ts'),
    // Stamps the manifest. Injectable, and not part of the run key.
    path.join(ROOT, 'engine', 'runBacktest.ts'),
    path.join(ROOT, 'results', 'runManifest.ts'),
    path.join(ROOT, 'results', 'resultWriter.ts'),
    // The LIVE feed. Wall time is not a defect here, it is the input: a
    // shadow run's clock is the socket's arrival times and its stop condition
    // is a real duration. The rule this test enforces is about the SIMULATED
    // path, and a live adapter is by definition not on it. The exemption is
    // one file wide, and everything downstream of it -- engine, strategies,
    // fill models, metrics -- stays under the rule.
    path.join(ROOT, 'data', 'liveKalshiSource.ts'),
  ]);

  it('never reads wall time or randomness in the simulated path', () => {
    // Exemptions are listed above and each one is justified there. A new file
    // failing this test should almost always be fixed rather than exempted:
    // the list is short on purpose.
    const forbidden = [
      { pattern: /\bDate\.now\s*\(/, why: 'Date.now() -- use ctx.clock.nowMs()' },
      { pattern: /\bsetTimeout\s*\(/, why: 'setTimeout -- use ctx.scheduleAfter()' },
      { pattern: /\bsetInterval\s*\(/, why: 'setInterval -- use ctx.scheduleAfter()' },
      { pattern: /\bMath\.random\s*\(/, why: 'Math.random() -- seed it and record the seed' },
      { pattern: /\bnew Date\s*\(\s*\)/, why: 'new Date() -- use ctx.clock.nowMs()' },
    ];

    const violations: string[] = [];
    for (const file of filesUnder(ROOT)) {
      if (EXEMPT.has(file)) continue;
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      for (const { pattern, why } of forbidden) {
        if (pattern.test(source)) violations.push(`${rel(file)}: ${why}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
