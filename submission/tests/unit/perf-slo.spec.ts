/**
 * Tests OF the T2 SLO gate (tools/perf/check-slo.ts), no network and no JMeter.
 * If the gate computes a percentile or a regression wrongly, every perf verdict built
 * on it is wrong, so it is checked in the PR static gate like the contract validator.
 */
import { test, expect } from '@playwright/test';
import { parseJtl, percentile, summarize, evaluate, compareToHistory, type HistoryRun, type LabelStats, type Sample } from '../../tools/perf/check-slo';

const HEADER = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';
const csv = (v: string | number | boolean) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
const line = (t: number, elapsed: number, label: string, code = '201', success = true, failure = '') =>
  [t, elapsed, label, code, 'Created', 'load 1-1', 'text', success, failure, 120, 90, 1, 1, 'http://x/transactions', elapsed, 0, 2].map(csv).join(',');
const sample = (t: number, elapsed: number, label: string, success = true): Sample => ({ t, elapsed, label, code: success ? '201' : '500', success, message: '' });
const stats = (label: string, p95: number, count = 5000): LabelStats => ({ label, count, errors: 0, errorRate: 0, p50: p95 / 2, p95, p99: p95 * 2, throughputPerSec: 50 });
const RULES = { historySize: 7, minHistory: 3, relativeIncrease: 0.2, absoluteFloorMs: 50, minSamples: 1000 };
const history = (...p95s: number[]): HistoryRun[] => p95s.map((p) => ({ at: 'x', stats: { 'POST /transactions': stats('POST /transactions', p) }, suspects: [] }));

test.describe('perf SLO gate', { tag: ['@pr', '@unit'] }, () => {
  test('parses a JMeter CSV results file, including quoted fields that contain commas and quotes', () => {
    const jtl = [HEADER, line(1000, 42, 'POST /transactions'), line(1010, 900, 'POST /transactions', '500', false, 'Test failed: code expected to equal /201/, got "500"')].join('\n');
    const s = parseJtl(jtl);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ t: 1000, elapsed: 42, label: 'POST /transactions', code: '201', success: true });
    expect(s[1]).toMatchObject({ code: '500', success: false, message: 'Test failed: code expected to equal /201/, got "500"' });
  });

  test('nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(xs, 50), percentile(xs, 95), percentile(xs, 99), percentile(xs, 100)]).toEqual([50, 95, 99, 100]);
    expect(percentile([7], 99)).toBe(7);
  });

  test('warm-up is excluded only for the ramped load labels, never for the storm', () => {
    const t0 = 1_000_000;
    const samples = [
      sample(t0, 5000, 'POST /transactions'),            // during the 60 s ramp: excluded
      sample(t0 + 61_000, 100, 'POST /transactions'),    // steady state: kept
      sample(t0 + 2_000, 300, 'POST /transactions (same-key storm)'), // storm, early: kept
    ];
    const s = summarize(samples, 60, new Set(['POST /transactions']));
    expect(s['POST /transactions'].count).toBe(1);
    expect(s['POST /transactions'].p95).toBe(100);
    expect(s['POST /transactions (same-key storm)'].count).toBe(1);
  });

  test('SLO evaluation flags latency, error-rate and throughput breaches and failed checks', () => {
    const s = { 'POST /transactions': { ...stats('POST /transactions', 450), errorRate: 0.01, throughputPerSec: 30 } };
    const check: Sample = { t: 0, elapsed: 0, label: 'CHECK idempotency (same-key storm)', code: '500', success: false, message: '20 keys, 3 with more than one transaction' };
    const f = evaluate(s, { 'POST /transactions': { p95Ms: 300, p99Ms: 800, maxErrorRate: 0.001, minThroughputRatio: 0.95 } }, { 'POST /transactions': 50 }, [check]);
    expect(f.map((x) => x.kind).sort()).toEqual(['check', 'invalid-run', 'slo', 'slo', 'slo']);
    expect(f.find((x) => x.kind === 'check')?.message).toContain('3 with more than one transaction');
  });

  test('a run inside every SLO, with a passing check, has no findings', () => {
    const s = { 'POST /transactions': stats('POST /transactions', 250) };
    s['POST /transactions'].p99 = 600;
    const ok: Sample = { t: 0, elapsed: 0, label: 'CHECK idempotency (same-key storm)', code: '200', success: true, message: '' };
    expect(evaluate(s, { 'POST /transactions': { p95Ms: 300, p99Ms: 800, maxErrorRate: 0.001, minThroughputRatio: 0.95 } }, { 'POST /transactions': 50 }, [ok])).toEqual([]);
  });

  test('regression gate: noise below the relative or absolute threshold is ignored', () => {
    const h = history(100, 110, 105); // median 105
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 120) }, h, RULES)).toEqual([]); // +14%: below 20%
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 140) }, h, RULES)).toEqual([]); // +33% but only +35 ms
  });

  test('regression gate: a real slowdown is suspected first, confirmed on the next run', () => {
    const h = history(100, 110, 105);
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 200) }, h, RULES)[0].kind).toBe('regression-suspected');
    h[h.length - 1].suspects = ['POST /transactions'];
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 200) }, h, RULES)[0].kind).toBe('regression-confirmed');
  });

  test('regression gate: no verdict without enough history or enough samples', () => {
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 500) }, history(100, 100), RULES)[0].kind).toBe('no-baseline');
    expect(compareToHistory({ 'POST /transactions': stats('POST /transactions', 500, 200) }, history(100, 100, 100), RULES)[0].kind).toBe('inconclusive');
  });
});
