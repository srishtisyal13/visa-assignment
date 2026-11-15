/**
 * Tests OF the validation layer (no network). If the validator cannot catch
 * a bad response, every green contract check built on it is a false pass, so
 * these run first in every gate.
 */
import { test, expect } from '@playwright/test';
import { ContractValidator } from '../../framework/contract/validator';

const v1 = new ContractValidator('contract/transactions-service.v1.yaml');
const v11 = new ContractValidator('contract/proposed/transactions-service.v1.1-proposed.yaml');

const goodTx = { transaction_id: 1, account_id: 1, operation_type_id: 1, amount: -50, type: 'debit', event_date: '2026-05-28T17:00:00Z' };

test.describe('validator catches what it should', { tag: ['@pr', '@unit'] }, () => {
  test('conformant 201 transaction passes', () => {
    expect(v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body: goodTx })).toEqual([]);
  });

  test('wrong property type is a schema violation anchored to the response schema', () => {
    const out = v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body: { ...goodTx, amount: '-50' } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: 'schema', contractAnchor: '#/paths/~1transactions/post/responses/201/schema' });
  });

  test('undocumented status is flagged (e.g. 404 or 500 on POST /transactions)', () => {
    for (const status of [404, 409, 415, 500]) {
      const out = v1.validateResponse({ method: 'POST', path: '/transactions', status, contentType: 'application/json', body: { error: 'x' } });
      expect(out[0]?.rule, `status ${status}`).toBe('undocumented-status');
    }
  });

  test('wrong media type is flagged', () => {
    const out = v1.validateResponse({ method: 'GET', path: '/accounts/7', status: 200, contentType: 'text/plain', body: { account_id: 7, document_number: '1' } });
    expect(out.map((o) => o.rule)).toContain('media-type');
  });

  test('405 on an undeclared method is checked against the declared 405 schema', () => {
    const problem = { type: 'x', title: 'y', status: 405, detail: 'z' };
    expect(v1.validateResponse({ method: 'DELETE', path: '/accounts', status: 405, contentType: 'application/json', body: problem })).toEqual([]);
    // ^ passes ONLY because errorResponse has no `required` (CF-03). The proposed contract closes this:
    expect(v11.validateResponse({ method: 'DELETE', path: '/accounts', status: 405, contentType: 'application/json', body: problem }).length).toBeGreaterThan(0);
  });

  test('strict mode (assumption, not contract) flags undeclared fields for drift detection', () => {
    const body = { ...goodTx, balance: 10 };
    expect(v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body })).toEqual([]);
    expect(v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body }, 'strict')[0].rule).toBe('schema');
  });
});

test.describe('validator documents what the v1 contract fails to constrain', { tag: ['@pr', '@unit'] }, () => {
  // These pass today and are EVIDENCE for contract findings. If the provider
  // tightens the contract they will fail, and that is the signal to update C3a.
  test('CF-03: an empty object is a valid v1 transaction response', () => {
    expect(v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body: {} })).toEqual([]);
  });

  test('CF-03: an empty object is a valid v1 create-transaction request', () => {
    expect(v1.validateRequestBody('POST', '/transactions', {})).toEqual([]);
  });

  test('CF-02/05/07: negative, zero, huge, sub-paisa amounts and op type 99 are all valid v1 requests', () => {
    for (const amount of [-50, 0, 1e308, 0.0001]) {
      expect(v1.validateRequestBody('POST', '/transactions', { account_id: 1, operation_type_id: 99, amount })).toEqual([]);
    }
  });

  test('CF-08: type "banana" is a valid v1 transaction type', () => {
    expect(v1.validateResponse({ method: 'POST', path: '/transactions', status: 201, contentType: 'application/json', body: { ...goodTx, type: 'banana' } })).toEqual([]);
  });

  test('CF-01/12: v1 declares no header parameters at all (no idempotency key, no request id)', () => {
    expect(v1.declaredHeaders('POST', '/transactions')).toEqual([]);
    expect(v11.declaredHeaders('POST', '/transactions')).toEqual(['X-Request-Id', 'Idempotency-Key']);
  });

  test('proposed v1.1 rejects what v1 lets through', () => {
    expect(v11.validateRequestBody('POST', '/transactions', {}).length).toBeGreaterThan(0);
    expect(v11.validateRequestBody('POST', '/transactions', { account_id: 1, operation_type_id: 99, amount: 5 }).length).toBeGreaterThan(0);
    expect(v11.validateRequestBody('POST', '/transactions', { account_id: 1, operation_type_id: 1, amount: -5 }).length).toBeGreaterThan(0);
    expect(v11.validateRequestBody('POST', '/accounts', { document_number: '123' }).length).toBeGreaterThan(0);
  });
});
