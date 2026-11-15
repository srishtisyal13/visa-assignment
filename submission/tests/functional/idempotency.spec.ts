/**
 * Idempotency behaviour (sequential). The concurrent case is T1 (tests/incident).
 *
 * The v1 contract declares NO idempotency header (CF-01). Everything here rests
 * on hearsay H3 ("same key, you get the original response back") plus the
 * semantics of the IETF Idempotency-Key draft. The header name itself is an
 * assumption (OQ-6), configurable per target.
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

test.describe('idempotency', { tag: ['@pr', '@functional', '@p0'] }, () => {
  test('ID-01 replay with same key + same body returns the original response and creates nothing new', async ({ api, account, data, caps }) => {
    oracle(
      { authority: 'hearsay', asserts: 'same key -> original response (same transaction_id, same body)', source: 'H3', risks: ['R1'] },
      { authority: 'domain', asserts: 'count of transactions for the key stays 1 (verified by count, not by replay equality)', source: 'T1 §2', risks: ['R1'] },
    );
    const key = data.idempotencyKey();
    const body = { account_id: account.account_id, operation_type_id: 1, amount: 42.5 };
    const first = await api.createTransaction(body, { idempotencyKey: key });
    const replay = await api.createTransaction(body, { idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    test.skip(!caps.transactionListing, 'count not observable on this target (CF-01): replay equality above is NOT proof of exactly-once');
    const list = await api.listTransactions(account.account_id, { idempotency_key: key });
    expect(list.body.transactions).toHaveLength(1);
  });

  test('ID-02 same key + DIFFERENT body is rejected, original is untouched', async ({ api, account, data, caps }) => {
    oracle(
      { authority: 'assumption', asserts: 'key reuse with a different payload -> 422 (IETF draft semantics); never a silent replay of the first', source: 'OQ-6; C5 PD-7', risks: ['R1', 'R2'] },
    );
    const key = data.idempotencyKey();
    const first = await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: 10 }, { idempotencyKey: key });
    const reuse = await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: 1000 }, { idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(reuse.status, 'a client bug that reuses keys must be surfaced, not swallowed').toBe(422);
    if (caps.transactionListing) {
      const list = await api.listTransactions(account.account_id);
      expect(list.body.transactions).toHaveLength(1);
      expect(list.body.transactions[0].amount).toBe(-10);
    }
  });

  test('ID-03 missing idempotency key is rejected (400), not processed without protection', async ({ api, account }) => {
    oracle(
      { authority: 'hearsay', asserts: 'an idempotency header exists', source: 'H3', risks: ['R1'] },
      { authority: 'domain', asserts: 'for money movement the key must be REQUIRED; optional keys mean unprotected retries', source: 'CF-01; OQ-6', risks: ['R1'] },
    );
    const res = await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: 10 }, { idempotencyKey: null });
    expect(res.status).toBe(400);
  });

  test('ID-04 the same key on two different accounts does not cross-replay', async ({ api, data }) => {
    oracle({ authority: 'assumption', asserts: 'key scope includes the request body (hence account); a replay never returns another account\'s transaction', source: 'OQ-6', risks: ['R3', 'R1'] });
    const key = data.idempotencyKey();
    const a = (await api.createAccount(data.documentNumber())).body.account_id;
    const b = (await api.createAccount(data.documentNumber())).body.account_id;
    await api.createTransaction({ account_id: a, operation_type_id: 1, amount: 5 }, { idempotencyKey: key });
    const other = await api.createTransaction({ account_id: b, operation_type_id: 1, amount: 5 }, { idempotencyKey: key });
    if (other.status === 201) expect(other.body.account_id).toBe(b);
    else expect(other.status).toBe(422);
  });
});
