/**
 * T2 runner: `npm run perf`.
 *
 * Resolves the target exactly like the test suite (framework/config/targets.ts, so
 * TARGET=staging|uat|preprod|… with <ENV>_URL or TARGET_URL), runs the JMeter plan in
 * non-GUI mode with the load profile from perf/slo.json, generates JMeter's HTML
 * dashboard, then evaluates the SLOs (tools/perf/check-slo.ts).
 *
 *   TARGET=staging STAGING_URL=https://… npm run perf
 *   TARGET=uat UAT_URL=https://… npm run perf -- --history reports/perf/history.json
 *   TARGET=fake npm run perf -- --harness-check        # only proves the plan executes; timings not evaluated
 *
 * Reports (all under reports/perf/):
 *   html/index.html   JMeter HTML dashboard (latency over time, percentiles, throughput, errors)
 *   results.jtl       raw samples (CSV)          jmeter.log     JMeter's own log
 *   slo-report.md     SLO verdict per label      summary.json   the same, machine-readable
 *   idempotency.json  same-key storm: transactions per key
 *
 * Overrides for a shorter or lighter run: PERF_TX_RATE, PERF_ACC_RATE, PERF_RAMP_SEC,
 * PERF_STEADY_SEC, PERF_ACCOUNT_POOL, PERF_STORM_CONCURRENCY, PERF_STORM_ROUNDS.
 * JMeter: Apache JMeter 5.6.3 (Java 17+) on PATH, or JMETER_BIN=/path/to/jmeter.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TARGET } from '../../framework/config/targets';
import { runCheck, type Load } from './check-slo';

const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const harness = argv.includes('--harness-check');
const historyArg = argv.indexOf('--history') > -1 ? argv[argv.indexOf('--history') + 1] : undefined;

function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (TARGET.name === 'mock') {
  refuse(
    'perf: refusing to run against the Prism mock. A latency or throughput number from the mock measures this laptop and Prism, not the service.\n' +
      'Run it against a deployed environment, e.g. TARGET=staging STAGING_URL=https://… npm run perf (or TARGET=uat UAT_URL=…).',
  );
}
if (TARGET.name === 'fake' && !harness) {
  refuse('perf: the fault-injection fake is not the service either. Use `TARGET=fake npm run perf -- --harness-check` only to prove the plan executes (timings are not evaluated).');
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'perf/slo.json'), 'utf8'));
// A harness check is deliberately tiny: it exercises every thread group once or twice, nothing more.
const load: Load = harness
  ? { transactionsPerSec: 5, accountsPerSec: 2, rampSec: 1, steadySec: 10, accountPool: 5, stormConcurrency: 5, stormRounds: 3 }
  : { ...config.load };
const overrides: Record<keyof Load, string> = {
  transactionsPerSec: 'PERF_TX_RATE', accountsPerSec: 'PERF_ACC_RATE', rampSec: 'PERF_RAMP_SEC', steadySec: 'PERF_STEADY_SEC',
  accountPool: 'PERF_ACCOUNT_POOL', stormConcurrency: 'PERF_STORM_CONCURRENCY', stormRounds: 'PERF_STORM_ROUNDS',
};
for (const [k, envVar] of Object.entries(overrides) as [keyof Load, string][]) if (process.env[envVar]) load[k] = Number(process.env[envVar]);

const out = path.join(ROOT, 'reports/perf');
fs.rmSync(out, { recursive: true, force: true }); // the HTML dashboard needs an empty folder
fs.mkdirSync(out, { recursive: true });
const jtl = path.join(out, 'results.jtl');
// Digits only: the run id goes into synthetic 11-digit document numbers (9 + runId(5) + seq(5)).
const runId = (/^\d+$/.test(process.env.RUN_ID ?? '') ? process.env.RUN_ID! : String(crypto.randomInt(0, 100000))).slice(-5).padStart(5, '0');

const props: Record<string, string | number | boolean> = {
  baseUrl: TARGET.baseURL,
  idemHeader: TARGET.capabilities.idempotencyHeader,
  requestTimeoutMs: TARGET.requestTimeoutMs,
  transactionListing: TARGET.capabilities.transactionListing,
  txRate: load.transactionsPerSec,
  accRate: load.accountsPerSec,
  rampSec: load.rampSec,
  steadySec: load.steadySec,
  accountPool: load.accountPool,
  stormConcurrency: load.stormConcurrency,
  stormRounds: load.stormRounds,
  runId,
  idemReport: path.join(out, 'idempotency.json'),
  // Title of the HTML dashboard: a harness check must never be mistaken for a measurement.
  'jmeter.reportgenerator.report_title': `Transactions Service perf · TARGET=${TARGET.name}${harness ? ' · HARNESS CHECK: timings are not evidence' : ''}`,
};
const jmeter = process.env.JMETER_BIN || 'jmeter';
const args = [
  '-n', '-t', path.join(ROOT, 'perf/transactions.jmx'),
  '-l', jtl, '-j', path.join(out, 'jmeter.log'),
  '-e', '-o', path.join(out, 'html'),
  ...Object.entries(props).map(([k, v]) => `-J${k}=${v}`),
];
console.log(`perf: TARGET=${TARGET.name} ${TARGET.baseURL}${harness ? ' (harness check)' : ''}\n      ${JSON.stringify(load)}`);
const run = spawnSync(jmeter, args, { cwd: ROOT, stdio: 'inherit' });
if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') {
  refuse(`perf: JMeter not found ("${jmeter}"). Install Apache JMeter 5.6.3 (needs Java 17+) and put its bin/ on PATH, or set JMETER_BIN.`);
}
if (run.status !== 0) refuse(`perf: JMeter exited with ${run.status}; see reports/perf/jmeter.log`);

process.exit(runCheck({ jtl, historyFile: historyArg, harness, load }));
