/**
 * Contract-level checks. The oracle is the YAML itself, so these are the only
 * functional assertions that mean the same thing on the mock and on staging.
 *
 * What a green run proves ON THE MOCK: the harness, client, validator and CI
 * wiring work, and Prism honours the declared types. It does NOT prove the
 * service conforms. ON STAGING, the same assertions do test the service.
 */
import { test, expect, allowContractViolation } from '../../framework/fixtures';
import { oracle } from '../../framework/oracle';
import { knownMockDivergence } from '../../framework/mock-divergences';

test.describe('contract conformance: happy-path shapes', { tag: ['@pr', '@contract'] }, () => {
  test('CT-01 POST /accounts 201 body conforms to accountResponse', async ({ api, data }) => {
    oracle({ authority: 'contract', asserts: '201 with handler.accountResponse JSON body', source: 'yaml L80-83, L3-11', risks: ['R6'] });
    const res = await api.createAccount(data.documentNumber());
    expect(res.status).toBe(201);
    expect(res.violations).toEqual([]);
  });

  test('CT-02 GET /accounts/{id} 200 body conforms to accountResponse', async ({ api, account }) => {
    oracle({ authority: 'contract', asserts: '200 with handler.accountResponse JSON body', source: 'yaml L107-110', risks: ['R6'] });
    const res = await api.getAccount(account.account_id);
    expect(res.status).toBe(200);
    expect(res.violations).toEqual([]);
  });

  test('CT-03 POST /transactions 201 body conforms to transactionResponse', async ({ api, account, data, caps }) => {
    oracle({ authority: 'contract', asserts: '201 with handler.transactionResponse JSON body', source: 'yaml L144-147, L36-56', risks: ['R6'] });
    const res = await api.createTransaction(
      { account_id: account.account_id, operation_type_id: 1, amount: 50 },
      { idempotencyKey: data.idempotencyKey() },
    );
    expect(res.status).toBe(201);
    expect(res.violations).toEqual([]);
    // event_date is a bare string in v1 (CF-09). Assert parseability as a DOMAIN expectation, separately:
    if (caps.stateful) expect(Number.isNaN(Date.parse((res.body as { event_date: string }).event_date))).toBe(false);
  });
});

test.describe('contract conformance: declared types are enforced', { tag: ['@pr', '@contract'] }, () => {
  test('CT-10 document_number of JSON type number is rejected with 400', async ({ api }) => {
    oracle({ authority: 'contract', asserts: 'type: string violated -> 400 (only documented 4xx)', source: 'yaml L14-16, L84-87', risks: ['R7', 'R8'] });
    const res = await api.raw({ method: 'POST', path: '/accounts', data: { document_number: 12345678900 } });
    expect(res.status).toBe(400);
  });

  test('CT-11 non-integer accountId path param is rejected with 400', async ({ api }) => {
    oracle({ authority: 'contract', asserts: 'path param type: integer violated -> 400', source: 'yaml L98-103, L111-114', risks: ['R8'] });
    const res = await api.getAccount('abc');
    expect(res.status).toBe(400);
  });

  test('CT-12 amount of JSON type string is rejected (400 or 422, the two documented 4xx)', async ({ api, account, data }) => {
    oracle(
      { authority: 'contract', asserts: 'amount type: number violated -> 400 or 422', source: 'yaml L23-25, L148-159', risks: ['R2'] },
      { authority: 'domain', asserts: 'a string "50" must never be coerced into money', source: 'C1 R2', risks: ['R2'] },
    );
    const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: '50' }, { idempotencyKey: data.idempotencyKey() });
    expect([400, 422]).toContain(res.status);
  });

  test('CT-13 account_id of JSON type string is rejected (400 or 422)', async ({ api, data }) => {
    oracle({ authority: 'contract', asserts: 'account_id type: integer violated -> 400 or 422', source: 'yaml L20-22', risks: ['R3'] });
    const res = await api.createTransaction({ account_id: '1', operation_type_id: 1, amount: 50 }, { idempotencyKey: data.idempotencyKey() });
    expect([400, 422]).toContain(res.status);
  });
});

test.describe('contract conformance: method not allowed', { tag: ['@pr', '@contract'] }, () => {
  const cases: [string, string][] = [
    ['DELETE', '/accounts'],
    ['PUT', '/accounts/1'],
    ['GET', '/transactions'],
    ['DELETE', '/transactions'],
  ];
  for (const [method, path] of cases) {
    test(`CT-20 ${method} ${path} -> 405 with errorResponse body`, async ({ api }) => {
      oracle({ authority: 'contract', asserts: '405 with handler.errorResponse, application/json', source: 'yaml L88-91, L119-122, L152-155', risks: ['R6', 'R8'] });
      knownMockDivergence('MOCK-1');
      allowContractViolation(api, 'asserted inline below so the mock divergence is attributable');
      const res = await api.raw({ method, path, data: method === 'GET' ? undefined : {} });
      expect(res.status).toBe(405);
      expect(res.violations, '405 body/media type must match the contract').toEqual([]);
    });
  }
});
