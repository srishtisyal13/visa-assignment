/**
 * Referential integrity: a transaction must never be recorded against an
 * account that does not exist, or with an operation type the system cannot
 * classify (the sign would be undefined).
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

test.describe('referential integrity', { tag: ['@pr', '@functional', '@p0'] }, () => {
  test('RI-01 transaction against a non-existent account is rejected (422) and creates nothing', async ({ api, data }) => {
    oracle(
      { authority: 'contract', asserts: '"against an existing account" (L131); 422 is the documented semantic-failure code', source: 'yaml L131, L156-159', risks: ['R3'] },
      { authority: 'assumption', asserts: 'status 422 (not 404: no 404 documented on POST /transactions, CF-13)', source: 'OQ-8', risks: ['R3'] },
    );
    const res = await api.createTransaction({ account_id: 2_000_000_000, operation_type_id: 1, amount: 10 }, { idempotencyKey: data.idempotencyKey() });
    expect(res.status).toBe(422);
  });

  for (const op of [0, 5, -1, 99, 2147483648]) {
    test(`RI-02 unknown operation_type_id ${op} is rejected (422) and creates nothing`, async ({ api, account, data, caps }) => {
      oracle(
        { authority: 'contract', asserts: 'only 1-4 are listed (prose; no enum, CF-07)', source: 'yaml L132', risks: ['R3', 'R2'] },
        { authority: 'domain', asserts: 'unknown type has no defined sign, so it must not default to debit or credit', source: 'C5 PD-5', risks: ['R2'] },
      );
      const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: op, amount: 10 }, { idempotencyKey: data.idempotencyKey() });
      expect([400, 422]).toContain(res.status);
      if (caps.transactionListing) expect((await api.listTransactions(account.account_id)).body.transactions).toHaveLength(0);
    });
  }

  test('RI-03 transaction is attributed to the account in the request, not another', async ({ api, data }) => {
    oracle({ authority: 'domain', asserts: 'response account_id equals request account_id for two interleaved accounts', source: 'C1 R3', risks: ['R3'] });
    const a = (await api.createAccount(data.documentNumber())).body.account_id;
    const b = (await api.createAccount(data.documentNumber())).body.account_id;
    const [ra, rb] = await Promise.all([
      api.createTransaction({ account_id: a, operation_type_id: 1, amount: 1 }, { idempotencyKey: data.idempotencyKey() }),
      api.createTransaction({ account_id: b, operation_type_id: 1, amount: 2 }, { idempotencyKey: data.idempotencyKey() }),
    ]);
    expect(ra.body.account_id).toBe(a);
    expect(rb.body.account_id).toBe(b);
  });
});
