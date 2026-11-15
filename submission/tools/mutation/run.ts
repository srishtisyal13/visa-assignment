/**
 * Mutation run ("test the test"): proves the suite can go RED.
 *
 * For each known fault in the fault-injection fake: start the fake with only
 * that fault, run the whole suite against it, and record which tests failed.
 * A fault that no test catches is a SURVIVOR: a hole where the suite would
 * green-light a broken service (false pass). The run fails if any P0 fault
 * survives, or if the baseline (no faults) is not fully green (false fail).
 *
 *   npm run test:mutation                 # all faults
 *   npm run test:mutation -- idem-race    # one fault
 *
 * Output: console table + reports/mutation-report.md + reports/mutation.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_FAULTS, type Fault } from '../fault-fake/server-faults';

const ROOT = path.resolve(__dirname, '../..');
const REPORTS = path.join(ROOT, 'reports');
fs.mkdirSync(REPORTS, { recursive: true });

/** Which faults are P0 (money-impacting). A surviving P0 fault fails the gate. */
const P0: Fault[] = ['idem-race', 'no-idem', 'idem-body-blind', 'sign', 'float-minor', 'negative-flips', 'unknown-op-accepted', 'ignore-unknown-fields'];

interface RunResult { failed: string[]; passed: number; skipped: number; unexpected: number; flaky: number; durationMs: number }

function runSuite(faults: string, port: number): RunResult {
  const out = path.join(REPORTS, `mutation-${faults || 'baseline'}.json`);
  const started = Date.now();
  spawnSync('npx', ['playwright', 'test', '--reporter=json', '--project=functional', '--project=incident', '--project=e2e', '--project=contract'], {
    cwd: ROOT,
    env: { ...process.env, TARGET: 'fake', FAULTS: faults, FAKE_PORT: String(port), PLAYWRIGHT_JSON_OUTPUT_NAME: out, CI: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  const failed: string[] = [];
  const walk = (s: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const sp of s.specs ?? []) for (const t of sp.tests) if (t.status === 'unexpected') failed.push(sp.title.split(' ').slice(0, 1)[0] + ' ' + sp.title.split(' ').slice(1, 8).join(' '));
    for (const c of s.suites ?? []) walk(c);
  };
  r.suites.forEach(walk);
  return { failed, passed: r.stats.expected, skipped: r.stats.skipped, unexpected: r.stats.unexpected, flaky: r.stats.flaky, durationMs: Date.now() - started };
}

const only = process.argv.slice(2).filter((a) => a in ALL_FAULTS) as Fault[];
const faults = only.length ? only : (Object.keys(ALL_FAULTS) as Fault[]);

console.log('baseline (no faults)…');
const baseline = runSuite('', 4030);
const rows: { fault: string; desc: string; p0: boolean; killed: boolean; killers: string[] }[] = [];
let port = 4031;
for (const f of faults) {
  process.stdout.write(`fault ${f}… `);
  const r = runSuite(f, port++);
  rows.push({ fault: f, desc: ALL_FAULTS[f], p0: P0.includes(f), killed: r.unexpected > 0, killers: r.failed });
  console.log(r.unexpected > 0 ? `KILLED by ${r.unexpected} test(s)` : 'SURVIVED');
}

const killed = rows.filter((r) => r.killed).length;
const survivorsP0 = rows.filter((r) => !r.killed && r.p0);
const md = [
  '# Mutation report (test-the-test)',
  '',
  `Generated ${new Date().toISOString()} against the fault-injection fake. **This measures the suite, not the service.**`,
  '',
  `- Baseline (no faults): ${baseline.passed} passed, ${baseline.unexpected} failed, ${baseline.flaky} flaky. Any baseline failure is a **false fail**.`,
  `- Mutation score: **${killed}/${rows.length}** faults killed. Survivors are **false passes** the suite would let through.`,
  '',
  '| Fault | P0 | Result | Killed by (first 4) |',
  '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.fault}\`: ${r.desc} | ${r.p0 ? 'yes' : ''} | ${r.killed ? 'killed' : '**SURVIVED**'} | ${r.killers.slice(0, 4).join('<br>')}${r.killers.length > 4 ? `<br>(+${r.killers.length - 4} more)` : ''} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(REPORTS, 'mutation-report.md'), md);
fs.writeFileSync(path.join(REPORTS, 'mutation.json'), JSON.stringify({ baseline, rows }, null, 2));
console.log('\n' + md);

if (baseline.unexpected > 0) { console.error('FAIL: baseline not green (false fails)'); process.exit(1); }
if (survivorsP0.length) { console.error(`FAIL: P0 faults survived: ${survivorsP0.map((s) => s.fault).join(', ')}`); process.exit(1); }
