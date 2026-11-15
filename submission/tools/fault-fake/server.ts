/**
 * FAULT-INJECTION FAKE: a "test the test" tool. NOT a model of the real service.
 *
 * Why it exists: a green run against Prism proves only that the harness works.
 * It does not prove that a test would go RED if the behaviour it guards were
 * broken. This fake implements MY ASSUMED semantics of the proposed v1.1
 * contract, and lets us switch on one known defect at a time (FAULTS env).
 * The mutation runner (tools/mutation/run.ts) then checks that the right tests
 * fail for each fault. That gives a measured false-pass rate for the suite.
 *
 * Passing against this fake with no faults proves the tests are internally
 * consistent with my assumptions. It says NOTHING about the real service.
 *
 *   FAULTS=idem-race,sign  PORT=4020  npx tsx tools/fault-fake/server.ts
 */
import http from 'node:http';
import crypto from 'node:crypto';

import { ALL_FAULTS, type Fault } from './server-faults';

const faults = new Set((process.env.FAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Fault[]);
for (const f of faults) if (!(f in ALL_FAULTS)) throw new Error(`unknown fault ${f}`);
const on = (f: Fault) => faults.has(f);

const PORT = Number(process.env.PORT ?? 4020);
const MAX_BODY = 64 * 1024;
const DB_LATENCY_MS = 15; // simulated write latency so races are reproducible

interface Account { account_id: number; document_number: string }
interface Tx { transaction_id: number; account_id: number; operation_type_id: number; amount_minor: number; event_date: string; idempotency_key?: string }
interface IdemEntry { bodyHash: string; status: number; body: unknown; done: boolean }

const accounts = new Map<number, Account>();
const docs = new Set<string>();
const txs: Tx[] = [];
const idem = new Map<string, IdemEntry>();
let accSeq = 0;
let txSeq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBIT_OPS = new Set([1, 2, 3]);

function toResponse(t: Tx) {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    operation_type_id: t.operation_type_id,
    amount: t.amount_minor / 100,
    type: t.amount_minor < 0 ? 'debit' : 'credit',
    event_date: t.event_date,
  };
}

function send(res: http.ServerResponse, reqId: string, status: number, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (!on('no-request-id')) headers['x-request-id'] = reqId;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
const err = (res: http.ServerResponse, reqId: string, status: number, error: string) => send(res, reqId, status, { error });

async function readBody(req: http.IncomingMessage): Promise<{ raw: string; tooLarge: boolean }> {
  // Drain the whole body even when it is too large. Breaking out early destroys
  // the socket mid-upload, and a pooled keep-alive client then hangs on its NEXT
  // request (observed: XC-14 poisoned the following test in the same worker).
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= MAX_BODY) chunks.push(c as Buffer);
  }
  if (size > MAX_BODY) return { raw: '', tooLarge: true };
  return { raw: Buffer.concat(chunks).toString('utf8'), tooLarge: false };
}

function decimals(n: number) {
  const s = String(n);
  if (s.includes('e-')) return 99;
  return s.includes('.') ? s.split('.')[1].length : 0;
}

async function parseJson(req: http.IncomingMessage, res: http.ServerResponse, reqId: string): Promise<Record<string, unknown> | undefined> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') { err(res, reqId, 415, 'content-type must be application/json'); return; }
  const { raw, tooLarge } = await readBody(req);
  if (tooLarge) { res.setHeader('connection', 'close'); err(res, reqId, 413, 'payload too large'); return; }
  if (!raw.trim()) { err(res, reqId, 400, 'empty body'); return; }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err(res, reqId, 400, 'body must be a JSON object'); return; }
    return v;
  } catch { err(res, reqId, 400, 'malformed JSON'); return; }
}

async function createTransaction(req: http.IncomingMessage, res: http.ServerResponse, reqId: string) {
  const body = await parseJson(req, res, reqId);
  if (!body) return;
  const key = req.headers['idempotency-key'] as string | undefined;
  if (!on('no-idem') && !key) return err(res, reqId, 400, 'Idempotency-Key header required');

  const unknown = Object.keys(body).filter((k) => !['account_id', 'operation_type_id', 'amount'].includes(k));
  if (unknown.length && !on('ignore-unknown-fields')) return err(res, reqId, 422, `unknown field(s): ${unknown.join(', ')}`);

  const { account_id, operation_type_id, amount } = body as { account_id: unknown; operation_type_id: unknown; amount: unknown };
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify({ account_id, operation_type_id, amount })).digest('hex');

  if (key && !on('no-idem')) {
    const seen = idem.get(key);
    if (seen) {
      if (seen.bodyHash !== bodyHash && !on('idem-body-blind')) return err(res, reqId, 422, 'idempotency key reused with a different body');
      if (!seen.done) return err(res, reqId, 409, 'request with this key in flight');
      return send(res, reqId, seen.status, seen.body, { 'idempotent-replayed': 'true' });
    }
    if (on('idem-race')) {
      await sleep(DB_LATENCY_MS); // check ... (gap) ... insert: the race window
    } else {
      idem.set(key, { bodyHash, status: 0, body: null, done: false }); // reserve atomically
    }
  }

  const finish = (status: number, b: unknown) => {
    if (key && !on('no-idem')) idem.set(key, { bodyHash, status, body: b, done: true });
    return send(res, reqId, status, b);
  };

  if (!Number.isInteger(account_id)) return finish(400, { error: 'account_id must be an integer' });
  if (!Number.isInteger(operation_type_id)) return finish(400, { error: 'operation_type_id must be an integer' });
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return finish(400, { error: 'amount must be a number' });
  const op = operation_type_id as number;
  if (![1, 2, 3, 4].includes(op) && !on('unknown-op-accepted')) return finish(422, { error: 'unknown operation type' });
  if (!accounts.has(account_id as number)) return finish(422, { error: 'account not found' });
  if (amount === 0) return finish(422, { error: 'amount must be positive' });
  if (amount < 0 && !on('negative-flips')) return finish(422, { error: 'amount must be positive' });
  if (Math.abs(amount) > 10_000_000) return finish(422, { error: 'amount exceeds maximum' });
  if (decimals(amount) > 2) return finish(422, { error: 'amount has more than 2 decimal places' });

  // Correct: integer minor units via rounding. Fault: truncation of a float product.
  const minor = on('float-minor') ? Math.floor(amount * 100) : Math.round(amount * 100);
  const debit = DEBIT_OPS.has(op) || (on('unknown-op-accepted') && op !== 4);
  // Sign rule applied to the raw value: with 'negative-flips', a -50 purchase becomes +50.
  let signed = debit ? -minor : minor;
  if (on('sign') && op === 4) signed = -Math.abs(minor);

  await sleep(DB_LATENCY_MS); // simulated INSERT
  const t: Tx = { transaction_id: ++txSeq, account_id: account_id as number, operation_type_id: op, amount_minor: signed, event_date: new Date().toISOString(), idempotency_key: key };
  txs.push(t);
  return finish(201, toResponse(t));
}

const DEBUG = process.env.FAKE_DEBUG === '1';
const server = http.createServer(async (req, res) => {
  if (DEBUG) {
    const t0 = Date.now();
    console.log(`> ${req.method} ${req.url} cl=${req.headers['content-length']}`);
    res.on('finish', () => console.log(`< ${res.statusCode} ${req.method} ${req.url} ${Date.now() - t0}ms`));
  }
  const reqId = (req.headers['x-request-id'] as string) || `srv-${crypto.randomUUID()}`;
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (p === '/accounts') {
      if (req.method !== 'POST') return err(res, reqId, 405, 'method not allowed');
      const body = await parseJson(req, res, reqId);
      if (!body) return;
      const doc = body.document_number;
      if (typeof doc !== 'string') return err(res, reqId, 400, 'document_number must be a string');
      if (!on('no-doc-validation') && !/^[0-9]{10,14}$/.test(doc)) return err(res, reqId, 400, 'document_number must be 10-14 digits');
      if (docs.has(doc) && !on('dup-doc')) return err(res, reqId, 409, 'document_number already registered');
      if (on('dup-doc-race')) { await sleep(DB_LATENCY_MS); docs.add(doc); }
      else { docs.add(doc); await sleep(DB_LATENCY_MS); } // reserve atomically, like a UNIQUE constraint
      const a = { account_id: ++accSeq, document_number: doc };
      accounts.set(a.account_id, a);
      return send(res, reqId, 201, a);
    }
    let m = p.match(/^\/accounts\/([^/]+)$/);
    if (m) {
      if (req.method !== 'GET') return err(res, reqId, 405, 'method not allowed');
      if (!/^[0-9]+$/.test(m[1])) return err(res, reqId, 400, 'accountId must be an integer');
      const a = accounts.get(Number(m[1]));
      return a ? send(res, reqId, 200, a) : err(res, reqId, 404, 'account not found');
    }
    m = p.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (m) {
      if (req.method !== 'GET') return err(res, reqId, 405, 'method not allowed');
      const id = Number(m[1]);
      if (!accounts.has(id)) return err(res, reqId, 404, 'account not found');
      const key = url.searchParams.get('idempotency_key');
      const list = txs.filter((t) => t.account_id === id && (key === null || t.idempotency_key === key)).map(toResponse);
      return send(res, reqId, 200, { transactions: list });
    }
    if (p === '/transactions') {
      if (req.method !== 'POST') return err(res, reqId, 405, 'method not allowed');
      return await createTransaction(req, res, reqId);
    }
    return err(res, reqId, 404, 'not found');
  } catch (e) {
    return err(res, reqId, 500, String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fault-fake listening on ${PORT} faults=[${[...faults].join(',')}]`);
});
