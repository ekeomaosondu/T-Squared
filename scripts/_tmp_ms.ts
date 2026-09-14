import '@/src/config/bootstrap';
import { env } from '@/src/config/env';
import { openLake } from '@/src/research/data/lakeSource';
async function main() {
  const src = openLake();
  const states = await src.marketStates({
    datasetId: env().DATASET_ID,
    startTime: new Date('2026-09-13T00:00:00Z'),
    endTime: new Date('2026-09-14T00:00:00Z'),
  });
  console.log(`${states.size} market states`);
  const byState = new Map<string, number>();
  for (const s of states.values()) byState.set(s.state, (byState.get(s.state) ?? 0) + 1);
  console.log(Object.fromEntries(byState));
  for (const s of [...states.values()].slice(0, 3)) {
    console.log(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 420));
  }
  await src.close();
}
void main();
