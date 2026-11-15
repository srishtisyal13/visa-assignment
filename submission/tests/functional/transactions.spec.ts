/**
 * Transaction correctness per operation type: sign, `type`, and amount
 * round-tripping back to the caller's unit.
 *
 * Contract authority is thin: yaml L131-133 says "Send a positive amount. The
 * server applies the correct sign based on operation type" but never says WHICH
 * sign. The mapping (1,2,3 debit/negative; 4 credit/positive) comes from hearsay
 * H2 and the response example (amount -100.5, type debit for op 1, L42/L54).
 * The `type` values debit/credit come from ONE example (CF-08).
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

const OPS = [
  { id: 1, name: 'Normal Purchase', sign: -1, type: 'debit' },
  { id: 2, name: 'Purchase with installments', sign: -1, type: 'debit' },
  { id: 3, name: 'Withdrawal', sign: -1, type: 'debit' },
  { id: 4, name: 'Credit Voucher', sign: 1, type: 'credit' },
] as const;

test.describe('sign and type per operation type', { tag: ['@pr', '@functional', '@p0'] }, () => {
  for (const op of OPS) {
    test(`TX-0${op.id} ${op.name}: positive 123.45 -> ${op.sign < 0 ? '-' : '+'}123.45, type=${op.type}`, async ({ api, account, data }) => {
      oracle(
        { authority: 'contract', asserts: 'client sends positive; server applies sign', source: 'yaml L133', risks: ['R2'] },
        { authority: 'hearsay', asserts: `op ${op.id} -> ${op.sign < 0 ? 'negative' : 'positive'}`, source: 'H2', risks: ['R2'] },
        { authority: 'assumption', asserts: `type == "${op.type}" (only one example value exists in contract)`, source: 'yaml L54; CF-08; OQ-7', risks: ['R2', 'R6'] },
      );
      const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: op.id, amount: 123.45 }, { idempotencyKey: data.idempotencyKey() });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        account_id: account.account_id,
        operation_type_id: op.id,
        amount: op.sign * 123.45,
        type: op.type,
      });
      expect(Number.isInteger(res.body.transaction_id)).toBe(true);
    });
  }
});

test.describe('amount round-trips back in the caller\'s unit (H1: rupees in, paise stored)', { tag: ['@pr', '@functional', '@p0'] }, () => {
  // Values chosen because they are NOT exactly representable in binary floating
  // point: a naive float*100 then truncate implementation corrupts them.
  for (const amount of [0.01, 0.1, 0.29, 4.35, 19.99, 1234567.89]) {
    test(`TX-10 ${amount} rupees round-trips exactly`, async ({ api, account, data }) => {
      oracle(
        { authority: 'hearsay', asserts: 'stored in smallest unit, returned in rupees: |returned| === sent', source: 'H1', risks: ['R2'] },
        { authority: 'domain', asserts: 'no float truncation (0.29 must not become 0.28)', source: 'C5 PD-3', risks: ['R2'] },
      );
      const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: 4, amount }, { idempotencyKey: data.idempotencyKey() });
      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(amount);
    });
  }
});
