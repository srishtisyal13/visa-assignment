/**
 * T2 SLO gate: evaluates a JMeter results file (JTL, CSV) against perf/slo.json.
 *
 * JMeter's HTML dashboard (reports/perf/html) is the human report. This is the
 * build gate, because JMeter itself cannot fail a build on a percentile:
 *   - absolute SLOs per request label (p95, p99, error rate, achieved throughput)
 *   - correctness: every "CHECK …" sample (the idempotency check) must pass
 *   - optional relative regression gate against a rolling history (noise-aware)
 *
 *   npm run perf:check -- --jtl reports/perf/results.jtl [--history reports/perf/history.json] [--harness]
 *
 * Exit 0 = pass (suspected regressions are warnings), 1 = SLO breach, failed check or confirmed regression.
 * Pure functions are exported for tests/unit/perf-slo.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Sample { t: number; elapsed: number; label: string; code: string; success: boolean; message: string }
export interface LabelStats { label: string; count: number; errors: number; errorRate: number; p50: number; p95: number; p99: number; throughputPerSec: number }
export interface Slo { p95Ms?: number; p99Ms?: number; maxErrorRate?: number; minThroughputRatio?: number }
export interface RegressionRules { historySize: number; minHistory: number; relativeIncrease: number; absoluteFloorMs: number; minSamples: number }
export interface Finding { label: string; kind: 'slo' | 'check' | 'invalid-run' | 'regression-suspected' | 'regression-confirmed' | 'no-baseline' | 'inconclusive'; message: string }
export interface HistoryRun { at: string; stats: Record<string, LabelStats>; suspects: string[] }

/** Minimal RFC 4180 CSV parser: JMeter quotes fields that contain commas, quotes or newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parses a JMeter CSV JTL (with its header line) into samples. */
export function parseJtl(text: string): Sample[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`JTL has no "${name}" column (header: ${header.join(',')})`);
    return i;
  };
  const [t, elapsed, label, code, success, failure, responseMsg] = ['timeStamp', 'elapsed', 'label', 'responseCode', 'success', 'failureMessage', 'responseMessage'].map(col);
  // Assertion failures land in failureMessage; the CHECK sampler reports its verdict in responseMessage.
  return rows.map((r) => ({ t: Number(r[t]), elapsed: Number(r[elapsed]), label: r[label], code: r[code], success: r[success] === 'true', message: r[failure] || r[responseMsg] || '' }));
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

/**
 * Per-label statistics, excluding samples that started during the ramp-up (warm-up).
 * `warmupLabels` limits the exclusion to the open-model load labels: the storm has no ramp and
 * may finish inside the warm-up window, so excluding its early samples would discard all of them.
 */
export function summarize(samples: Sample[], warmupSec: number, warmupLabels?: Set<string>): Record<string, LabelStats> {
  if (!samples.length) return {};
  const ramped = (s: Sample) => !warmupLabels || warmupLabels.has(s.label);
  const rampedSamples = samples.filter(ramped);
  const start = rampedSamples.length ? Math.min(...rampedSamples.map((s) => s.t)) : 0;
  const steady = samples.filter((s) => !ramped(s) || s.t >= start + warmupSec * 1000);
  const byLabel = new Map<string, Sample[]>();
  for (const s of steady) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s]);
  const out: Record<string, LabelStats> = {};
  for (const [label, list] of byLabel) {
    const sorted = list.map((s) => s.elapsed).sort((a, b) => a - b);
    const first = Math.min(...list.map((s) => s.t));
    const last = Math.max(...list.map((s) => s.t + s.elapsed));
    const errors = list.filter((s) => !s.success).length;
    out[label] = {
      label, count: list.length, errors, errorRate: errors / list.length,
      p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
      throughputPerSec: list.length / Math.max((last - first) / 1000, 1),
    };
  }
  return out;
}

/** Absolute SLOs and correctness checks. `targetRates` maps a label to the arrival rate it was driven at. */
export function evaluate(stats: Record<string, LabelStats>, slos: Record<string, Slo>, targetRates: Record<string, number>, checks: Sample[]): Finding[] {
  const out: Finding[] = [];
  for (const [label, slo] of Object.entries(slos)) {
    const s = stats[label];
    if (!s) { out.push({ label, kind: 'invalid-run', message: 'no samples for this label' }); continue; }
    if (slo.p95Ms !== undefined && s.p95 > slo.p95Ms) out.push({ label, kind: 'slo', message: `p95 ${s.p95} ms > ${slo.p95Ms} ms` });
    if (slo.p99Ms !== undefined && s.p99 > slo.p99Ms) out.push({ label, kind: 'slo', message: `p99 ${s.p99} ms > ${slo.p99Ms} ms` });
    if (slo.maxErrorRate !== undefined && s.errorRate > slo.maxErrorRate) out.push({ label, kind: 'slo', message: `error rate ${(s.errorRate * 100).toFixed(2)}% > ${(slo.maxErrorRate * 100).toFixed(2)}%` });
    const target = targetRates[label];
    if (slo.minThroughputRatio !== undefined && target && s.throughputPerSec < target * slo.minThroughputRatio) {
      // Either the service saturated or the load generator couldn't keep up. Both make the latency numbers untrustworthy.
      out.push({ label, kind: 'invalid-run', message: `achieved ${s.throughputPerSec.toFixed(1)}/s < ${(slo.minThroughputRatio * 100).toFixed(0)}% of the ${target}/s target` });
    }
  }
  for (const c of checks) if (!c.success) out.push({ label: c.label, kind: 'check', message: c.message || `failed (response ${c.code})` });
  return out;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Relative regression gate, built not to fail on infrastructure noise:
 *  - compare p95 with the MEDIAN of the last N runs on the same environment (one noisy night can't move it);
 *  - flag only if p95 rose by more than `relativeIncrease` AND by more than `absoluteFloorMs` (10% of 20 ms is noise);
 *  - ignore labels with too few samples;
 *  - a first breach is only "suspected"; it is "confirmed" (and fails) when the previous run was also suspect.
 */
export function compareToHistory(current: Record<string, LabelStats>, history: HistoryRun[], rules: RegressionRules): Finding[] {
  const recent = history.slice(-rules.historySize);
  const previousSuspects = new Set(history.at(-1)?.suspects ?? []);
  const out: Finding[] = [];
  for (const [label, s] of Object.entries(current)) {
    if (label.startsWith('CHECK ') || label.startsWith('setup:')) continue;
    const past = recent.map((r) => r.stats[label]?.p95).filter((x): x is number => Number.isFinite(x));
    if (past.length < rules.minHistory) { out.push({ label, kind: 'no-baseline', message: `${past.length}/${rules.minHistory} baseline runs so far` }); continue; }
    if (s.count < rules.minSamples) { out.push({ label, kind: 'inconclusive', message: `${s.count} samples < ${rules.minSamples}` }); continue; }
    const base = median(past);
    if (s.p95 > base * (1 + rules.relativeIncrease) && s.p95 - base > rules.absoluteFloorMs) {
      const msg = `p95 ${s.p95} ms vs baseline median ${base} ms (+${(((s.p95 - base) / base) * 100).toFixed(0)}%)`;
      out.push({ label, kind: previousSuspects.has(label) ? 'regression-confirmed' : 'regression-suspected', message: msg });
    }
  }
  return out;
}

export interface Load { transactionsPerSec: number; accountsPerSec: number; rampSec: number; steadySec: number; accountPool: number; stormConcurrency: number; stormRounds: number }
export interface CheckOptions { jtl: string; historyFile?: string; harness?: boolean; load?: Partial<Load> }

/** Evaluates one run, writes slo-report.md + summary.json next to the JTL, and returns the exit code. */
export function runCheck(opts: CheckOptions): number {
  const ROOT = path.resolve(__dirname, '../..');
  const { jtl: jtlFile, historyFile, harness = false } = opts;
  const outDir = path.dirname(jtlFile);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'perf/slo.json'), 'utf8'));
  const load: Load = { ...config.load, ...(opts.load ?? {}) };

  const samples = parseJtl(fs.readFileSync(jtlFile, 'utf8'));
  const checks = samples.filter((s) => s.label.startsWith('CHECK '));
  const targetRates: Record<string, number> = { 'POST /transactions': load.transactionsPerSec, 'POST /accounts': load.accountsPerSec };
  const measured = samples.filter((s) => !s.label.startsWith('CHECK ') && !s.label.startsWith('setup:'));
  const stats = summarize(measured, harness ? 0 : load.rampSec, new Set(Object.keys(targetRates)));

  // A harness check proves the plan executes end to end; its timings are meaningless, so only
  // "every label produced samples" and the correctness checks are evaluated.
  const findings = harness
    ? [
        ...Object.keys(config.slos).filter((l) => !stats[l]).map((l): Finding => ({ label: l, kind: 'invalid-run', message: 'no samples for this label' })),
        ...evaluate({}, {}, {}, checks),
        ...(checks.length ? [] : [{ label: 'CHECK idempotency (same-key storm)', kind: 'invalid-run', message: 'check sample missing' } as Finding]),
      ]
    : evaluate(stats, config.slos, targetRates, checks);

  let regression: Finding[] = [];
  if (historyFile && !harness) {
    const history: HistoryRun[] = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')).runs ?? [] : [];
    regression = compareToHistory(stats, history, config.regressionGate);
    const suspects = regression.filter((f) => f.kind.startsWith('regression')).map((f) => f.label);
    // Only valid, SLO-passing runs become baseline, so a broken night can't drag the median.
    if (!findings.length) {
      history.push({ at: new Date().toISOString(), stats, suspects });
      fs.writeFileSync(historyFile, JSON.stringify({ runs: history.slice(-config.regressionGate.historySize) }, null, 2));
    }
  }

  const failing = [...findings, ...regression.filter((f) => f.kind === 'regression-confirmed')];
  const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : '-');
  const md = [
    `# Performance SLO report${harness ? ' (harness check: timings NOT evaluated)' : ''}`,
    '',
    `Verdict: **${failing.length ? 'FAIL' : 'PASS'}** · JMeter HTML dashboard: \`reports/perf/html/index.html\``,
    '',
    '| Label | Samples | Errors | p50 ms | p95 ms | p99 ms | Throughput /s | SLO p95 / p99 / errors |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.values(stats).map((s) => {
      const slo: Slo = config.slos[s.label] ?? {};
      return `| ${s.label} | ${s.count} | ${s.errors} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${s.throughputPerSec.toFixed(1)} | ${slo.p95Ms ?? '-'} / ${slo.p99Ms ?? '-'} / ${slo.maxErrorRate !== undefined ? (slo.maxErrorRate * 100).toFixed(1) + '%' : '-'} |`;
    }),
    '',
    ...checks.map((c) => `- ${c.success ? 'PASS' : 'FAIL'} ${c.label}: ${c.message || '(see reports/perf/idempotency.json)'}`),
    '',
    ...(failing.length ? ['**Failures**', ...failing.map((f) => `- [${f.kind}] ${f.label}: ${f.message}`), ''] : []),
    ...(regression.length ? ['**Regression gate**', ...regression.map((f) => `- [${f.kind}] ${f.label}: ${f.message}`), ''] : []),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'slo-report.md'), md);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ harness, stats, findings, regression }, null, 2));
  console.log(md);
  if (process.env.GITHUB_ACTIONS) for (const f of regression.filter((r) => r.kind === 'regression-suspected')) console.log(`::warning title=perf regression suspected::${f.label}: ${f.message}`);
  return failing.length ? 1 : 0;
}

if (require.main === module) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
  process.exit(runCheck({
    jtl: arg('--jtl') ?? path.resolve(__dirname, '../../reports/perf/results.jtl'),
    historyFile: arg('--history'),
    harness: process.argv.includes('--harness'),
  }));
}
