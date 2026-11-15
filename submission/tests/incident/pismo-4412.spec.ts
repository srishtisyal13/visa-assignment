/**
 * PISMO-4412 regression guardrail: double debit under a client retry storm.
 *
 * Oracle: N concurrent POST /transactions with the SAME idempotency key and
 * the same body produce EXACTLY ONE transaction, VERIFIED BY COUNT through a
 * read path, not by checking that the replies look alike.
 *
 * Runs unchanged against:
 *   - mock    : Prism serving the PROPOSED contract (v1.1). Green = harness works. Count is the spec example, so this is NOT evidence.
 *   - fake    : stateful fault-injection fake. With FAULTS=idem-race it MUST go red (tools/mutation).
 *   - staging : the real service. If staging has no listing endpoint (published v1),
 *               the test FAILS with "NOT VERIFIABLE". That is the correct outcome:
 *               the guarantee cannot be verified, so sign-off is blocked (docs/T1 §2).
 *
 * Knobs: T1_CONCURRENCY (default 25), T1_ROUNDS (default 1; pre-release uses 20).
 */
import { test, expect } from '../../framework/fixtures';
import { oracle } from '../../framework/oracle';
import { NotObservableError, type ApiResult } from '../../framework/client/transactions-client';

const N = Number(process.env.T1_CONCURRENCY ?? 25);
const ROUNDS = Number(process.env.T1_ROUNDS ?? 1);

async function storm<T>(n: number, fire: () => Promise<T>): Promise<T[]> {
  // Start barrier: build all promises first, then release them in the same tick,
  // so they genuinely overlap in the server's check-then-act window.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inflight = Array.from({ length: n }, () => gate.then(fire));
  release();
  return Promise.all(inflight);
}

test.describe('PISMO-4412 idempotency under concurrency', { tag: ['@pr', '@p0', '@incident'] }, () => {
  for (let round = 1; round <= ROUNDS; round++) {
    test(`T1-01 ${N} concurrent identical requests, one key -> exactly one transaction (round ${round}/${ROUNDS})`, async ({ api, account, data, caps }) => {
      oracle(
        { authority: 'hearsay', asserts: 'same key -> no double charge', source: 'H3', risks: ['R1'] },
        { authority: 'domain', asserts: `count(transactions where key=K) == 1 after ${N} concurrent sends`, source: 'T1 §1', risks: ['R1'] },
      );
      const key = data.idempotencyKey('pismo4412');
      const body = { account_id: account.account_id, operation_type_id: 1, amount: 12.34 };

      const results: ApiResult[] = await storm(N, () => api.createTransaction(body, { idempotencyKey: key }));

      await test.info().attach('status-histogram', {
        body: JSON.stringify(results.reduce<Record<number, number>>((h, r) => ({ ...h, [r.status]: (h[r.status] ?? 0) + 1 }), {})),
        contentType: 'application/json',
      });

      // (a) Nothing blew up. A 5xx under a storm is itself a defect (and a likely precursor to a double write).
      expect(results.filter((r) => r.status >= 500), '5xx during storm').toEqual([]);
      // (b) Every success is a 201 (original or replay) or a 409 "in flight": nothing else is acceptable.
      expect(results.every((r) => r.status === 201 || r.status === 409), `statuses: ${results.map((r) => r.status)}`).toBe(true);
      // (c) All successes name the same transaction. NECESSARY, NOT SUFFICIENT: a server can
      //     return identical replies while having written two rows (hypothesis H-A in docs/T1).
      const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.transaction_id));
      expect(ids.size, 'distinct transaction_ids returned').toBe(1);

      // (d) THE ORACLE: count by read-back.
      let listed: ApiResult;
      try {
        listed = await api.listTransactions(account.account_id, { idempotency_key: key });
      } catch (e) {
        if (e instanceof NotObservableError) {
          throw new Error(
            'NOT VERIFIABLE: the target exposes no way to count transactions (published contract has no read path for transactions). ' +
              '"Exactly one" cannot be proven, so PISMO-4412 sign-off is BLOCKED. Required change: docs/T1 §2 (CF-01).',
          );
        }
        throw e;
      }
      expect(listed.status).toBe(200);
      expect(listed.body.transactions, 'transactions recorded for this idempotency key').toHaveLength(1);

      if (caps.stateful) {
        // (e) Money view: the account's ledger moved by exactly one debit.
        const all = await api.listTransactions(account.account_id);
        const sumPaise = all.body.transactions.reduce((s: number, t: { amount: number }) => s + Math.round(t.amount * 100), 0);
        expect(sumPaise, 'net movement on the account').toBe(-1234);
      }
    });
  }

  test('T1-02 control: N concurrent requests with DISTINCT keys create N transactions', async ({ api, account, data, caps }) => {
    test.skip(!caps.stateful, 'needs a real store: on a mock the count is the spec example');
    oracle({ authority: 'domain', asserts: 'dedup is per-key, not "drop concurrent writes"; proves T1-01 can tell the difference', source: 'T1 §4', risks: ['R1'] });
    const body = { account_id: account.account_id, operation_type_id: 1, amount: 1 };
    const results = await storm(N, () => api.createTransaction(body, { idempotencyKey: data.idempotencyKey('control') }));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await api.listTransactions(account.account_id)).body.transactions).toHaveLength(N);
  });
});
