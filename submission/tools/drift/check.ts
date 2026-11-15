/**
 * Drift probe (C3b, mock fidelity). Sends a fixed, contract-derived set of
 * requests to a target and reports every way the observed responses differ
 * from the contract:
 *
 *   undocumented-status | media-type | schema | undeclared-field (strict) | undeclared-header
 *
 * Use it in three ways:
 *   1. against the MOCK: shows where the mock is unfaithful to its own contract (MOCK-1..3)
 *   2. against STAGING nightly: shows where reality differs from the contract (contract drift)
 *   3. diff two runs (--baseline file): turns "drift exists" into "drift CHANGED", which alerts
 *
 *   npm run drift:check -- --target http://127.0.0.1:4010     # with `npm run mock` running
 *   npm run drift:check -- --target $STAGING_URL --baseline reports/drift-staging-prev.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { ContractValidator } from '../../framework/contract/validator';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const target = arg('--target') ?? 'http://127.0.0.1:4010';
const contractFile = arg('--contract') ?? 'contract/transactions-service.v1.yaml';
const baselineFile = arg('--baseline');
const v = new ContractValidator(contractFile);

/** Response headers any HTTP server sends; not drift. */
const TRANSPORT_HEADERS = new Set(['content-type', 'content-length', 'date', 'connection', 'keep-alive', 'transfer-encoding', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-credentials', 'access-control-expose-headers', 'vary', 'server']);

const PROBES: { name: string; method: string; path: string; body?: string; headers?: Record<string, string> }[] = [
  { name: 'create account (valid)', method: 'POST', path: '/accounts', body: '{"document_number":"12345678901"}' },
  { name: 'create account (type error)', method: 'POST', path: '/accounts', body: '{"document_number":1}' },
  { name: 'get account', method: 'GET', path: '/accounts/1' },
  { name: 'get account (bad id)', method: 'GET', path: '/accounts/abc' },
  { name: 'get account (missing)', method: 'GET', path: '/accounts/2000000000' },
  { name: 'create transaction (valid)', method: 'POST', path: '/transactions', body: '{"account_id":1,"operation_type_id":1,"amount":50}', headers: { 'Idempotency-Key': `drift-${Date.now()}` } },
  { name: 'create transaction (type error)', method: 'POST', path: '/transactions', body: '{"account_id":1,"operation_type_id":1,"amount":"x"}' },
  { name: 'method not allowed', method: 'DELETE', path: '/accounts' },
  { name: 'wrong content-type', method: 'POST', path: '/accounts', body: 'x', headers: { 'content-type': 'text/plain' } },
];

async function main() {
  const findings: { probe: string; status: number; kind: string; detail: string }[] = [];
  for (const p of PROBES) {
    let res: Response;
    try {
      res = await fetch(target + p.path, { method: p.method, body: p.body, headers: { 'content-type': 'application/json', ...(p.headers ?? {}) }, signal: AbortSignal.timeout(4000) });
    } catch (e) {
      findings.push({ probe: p.name, status: 0, kind: 'no-response', detail: String(e) });
      continue;
    }
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const ct = res.headers.get('content-type') ?? undefined;
    for (const x of v.validateResponse({ method: p.method, path: p.path, status: res.status, contentType: ct, body }, 'strict')) {
      const kind = x.rule === 'schema' && x.message.includes('additional') ? 'undeclared-field' : x.rule;
      findings.push({ probe: p.name, status: res.status, kind, detail: `${x.message} @ ${x.contractAnchor}` });
    }
    // Headers: the v1 contract declares none, so any non-transport header is drift
    // in the useful sense: something consumers may start to depend on.
    res.headers.forEach((_, h) => {
      if (!TRANSPORT_HEADERS.has(h.toLowerCase())) findings.push({ probe: p.name, status: res.status, kind: 'undeclared-header', detail: h });
    });
  }

  // Nothing answered at all: that is "target not running", not drift. Fail loudly and
  // don't write drift.json, so a dead target can never become the nightly baseline.
  if (findings.filter((f) => f.kind === 'no-response').length === PROBES.length) {
    console.error(`No response from ${target} for any of the ${PROBES.length} probes. Is it running? For the mock: npm run mock (in another terminal). Nothing was written.`);
    process.exit(1);
  }

  const key = (f: { probe: string; kind: string; detail: string }) => `${f.probe}|${f.kind}|${f.detail.replace(/\d{6,}/g, 'N')}`;
  console.log(`Drift vs ${contractFile} at ${target}: ${findings.length} finding(s)\n`);
  for (const f of findings) console.log(`  [${f.kind}] ${f.probe} -> ${f.status}: ${f.detail}`);

  const outDir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'drift.json'), JSON.stringify(findings, null, 2));

  if (baselineFile && fs.existsSync(baselineFile)) {
    const prev = new Set((JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as typeof findings).map(key));
    const now = new Set(findings.map(key));
    const added = [...now].filter((k) => !prev.has(k));
    const removed = [...prev].filter((k) => !now.has(k));
    console.log(`\nChange vs baseline: +${added.length} / -${removed.length}`);
    added.forEach((a) => console.log(`  + ${a}`));
    removed.forEach((r) => console.log(`  - ${r}`));
    process.exit(added.length ? 1 : 0); // new drift alerts; known drift is tracked, not re-alerted
  }
}

main();
