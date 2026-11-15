/**
 * Cross-cutting: request-ID, malformed JSON, wrong Content-Type, empty body,
 * oversized body. (Method-not-allowed is in tests/contract: its oracle is the YAML.)
 *
 * Where the contract decides the outcome, the case runs on the mock too. Where
 * the oracle is hearsay/domain, it needs a real service.
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.describe('request ID (hearsay H5, contract silent: CF-12)', { tag: ['@pr', '@functional'] }, () => {
  test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

  test('XC-01 every response carries a request ID, including errors', async ({ api, caps, account, data }) => {
    oracle({ authority: 'hearsay', asserts: `"every response" has ${caps.requestIdHeader}: 201, 200, 400, 404, 405, 422`, source: 'H5; OQ-9 (header name)', risks: ['R9'] });
    const header = caps.requestIdHeader.toLowerCase();
    const responses = await Promise.all([
      api.createAccount(data.documentNumber()),
      api.getAccount(account.account_id),
      api.createAccount(''),
      api.getAccount(2_000_000_000),
      api.raw({ method: 'DELETE', path: '/accounts' }),
      api.createTransaction({ account_id: 2_000_000_000, operation_type_id: 1, amount: 1 }, { idempotencyKey: data.idempotencyKey() }),
    ]);
    for (const r of responses) expect(r.headers[header], `${r.method} ${r.path} -> ${r.status}`).toBeTruthy();
  });

  test('XC-02 a client-supplied request ID is echoed back', async ({ api, caps, data }) => {
    oracle({ authority: 'assumption', asserts: 'inbound correlation id is propagated, not replaced', source: 'OQ-9', risks: ['R9'] });
    const rid = data.requestId();
    const res = await api.createAccount(data.documentNumber(), { [caps.requestIdHeader]: rid });
    expect(res.headers[caps.requestIdHeader.toLowerCase()]).toBe(rid);
  });

  test('XC-03 server-generated request IDs are unique per request', async ({ api, caps, account }) => {
    oracle({ authority: 'domain', asserts: 'IDs that repeat cannot be used to trace', source: 'H5', risks: ['R9'] });
    const ids = (await Promise.all(Array.from({ length: 20 }, () => api.getAccount(account.account_id)))).map((r) => r.headers[caps.requestIdHeader.toLowerCase()]);
    expect(new Set(ids).size).toBe(20);
  });
});

test.describe('malformed / wrong / empty / oversized input', { tag: ['@pr', '@functional'] }, () => {
  test('XC-10 malformed JSON on POST /accounts -> 400 (its only documented client error), promptly', async ({ api }) => {
    oracle(
      { authority: 'contract', asserts: 'POST /accounts documents 400 as its only client error, so unparseable JSON must get 400', source: 'yaml L84-87', risks: ['R8'] },
      { authority: 'domain', asserts: 'a syntax error is answered promptly (within 3 s), never left hanging', source: 'RFC 9110 §15.5.1; C3b MOCK-2', risks: ['R8'] },
    );
    const res = await api.raw({ method: 'POST', path: '/accounts', data: '{"document_number":', timeoutMs: 3_000 });
    expect(res.status).toBe(400);
  });

  test('XC-11 wrong Content-Type (text/plain) is rejected, never processed', async ({ api }) => {
    oracle(
      { authority: 'contract', asserts: 'consumes: application/json only', source: 'yaml L67-68, L128-129', risks: ['R8'] },
      { authority: 'assumption', asserts: '415 is correct HTTP but undocumented (CF-14); 400 is the documented fallback; either is accepted, 2xx is not', source: 'CF-14', risks: ['R8'] },
    );
    const res = await api.raw({ method: 'POST', path: '/accounts', data: '{"document_number":"12345678901"}', headers: { 'content-type': 'text/plain' } });
    expect([400, 415]).toContain(res.status);
  });

  test('XC-12 empty body on POST /accounts -> 400', async ({ api }) => {
    oracle({ authority: 'contract', asserts: 'body parameter is required: true', source: 'yaml L71-76', risks: ['R8'] });
    const res = await api.raw({ method: 'POST', path: '/accounts', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  test('XC-13 empty body on POST /transactions -> 400 or 422', async ({ api }) => {
    oracle(
      { authority: 'contract', asserts: 'body parameter is required: true; rejection is a documented 4xx', source: 'yaml L135-140, L148-159', risks: ['R8'] },
      { authority: 'assumption', asserts: 'contract does not say whether a missing body is 400 or 422 (CF-15), so either is accepted', source: 'CF-15', risks: ['R8'] },
    );
    const res = await api.raw({ method: 'POST', path: '/transactions', headers: { 'content-type': 'application/json' } });
    expect([400, 422]).toContain(res.status);
  });

  test('XC-14 oversized body (1 MiB) is rejected with 4xx, not 2xx/5xx', { tag: ['@nightly'] }, async ({ api, caps }) => {
    test.skip(!caps.stateful, NEEDS_REAL_SERVICE);
    oracle({ authority: 'domain', asserts: 'bounded request size; 413 (undocumented, CF-14) or 400', source: 'C1 R8; OQ-10', risks: ['R8'] });
    const res = await api.raw({ method: 'POST', path: '/accounts', data: JSON.stringify({ document_number: '1'.repeat(1024 * 1024) }), timeoutMs: 10_000,
      // Isolation: never return a half-written socket to the worker's pool (see docs/C2 §4.4).
      headers: { connection: 'close' } });
    expect([400, 413]).toContain(res.status);
  });
});

test.describe('unknown request fields', { tag: ['@pr', '@functional', '@p0'] }, () => {
  test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

  test('XC-15 a currency the service does not model is rejected, not silently dropped', async ({ api, account, data, caps }) => {
    oracle(
      { authority: 'domain', asserts: 'a request saying USD must never be booked as INR; reject with 400/422 and create nothing', source: 'CF-29; OQ-15; C5 PD-12', risks: ['R2'] },
      { authority: 'contract', asserts: 'CONTRACT PROMISES: nothing (no additionalProperties rule)', source: 'yaml L18-29', risks: ['R2'] },
    );
    const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: 50, currency: 'USD' }, { idempotencyKey: data.idempotencyKey() });
    expect([400, 422]).toContain(res.status);
    if (caps.transactionListing) expect((await api.listTransactions(account.account_id)).body.transactions).toHaveLength(0);
  });
});
