/**
 * Runs every attack demonstration and prints a summary table.
 *   npm run all -w @twin/attacks            (add --slow for the 35 s freshness tests)
 * Results are also written to docs/results/security-tests.json (used in Phase 9).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allResults } from './lib';
import { main as a1 } from './a1-eavesdrop-mitm';
import { main as a2 } from './a2-unauthenticated';
import { main as a3 } from './a3-acl-spoofing';
import { main as a4 } from './a4-forged-commands';
import { main as a5 } from './a5-telemetry-replay-tamper';
import { main as a6 } from './a6-flood';
import { main as a7 } from './a7-fdi';
import { main as a8 } from './a8-web';

const steps = [a1, a2, a3, a4, a5, a6, a8, a7];
for (const step of steps) {
  try {
    await step();
  } catch (e) {
    console.error(`  step failed: ${(e as Error).message}`);
  }
}

const res = allResults();
const held = res.filter((r) => r.held).length;
console.log(`\n=== SUMMARY: ${held}/${res.length} defences held ${'='.repeat(40)}`);
for (const r of res) console.log(`  ${r.held ? 'HELD  ' : 'FAILED'}  ${r.attack}`);

const out = resolve(import.meta.dirname, '../../../docs/results');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'security-tests.json'), JSON.stringify({ date: new Date().toISOString(), held, total: res.length, results: res }, null, 2) + '\n');
console.log('\nwritten docs/results/security-tests.json');
process.exit(held === res.length ? 0 : 1);
