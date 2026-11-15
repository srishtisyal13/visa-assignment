/**
 * T3: Playwright E2E with APIRequestContext.
 *
 * Scoped honestly: the service is API-only, so "end to end" here means one
 * cardholder's journey across every operation the contract exposes, driven
 * through HTTP exactly as a client would. There is no UI and no browser, and
 * none is pretended. Downstream effects (ledger, audit) are out of reach of
 * the published API (CF-01, H6) and are listed as unverified in the report.
 *
 * Two tests, split on purpose:
 *   J-01 journey wiring + contract shape   -> every target, including the mock
 *   J-02 resulting money state             -> stateful targets with a read path only
 * Mixing them would make J-01 pass on the mock "by example", which is the mock trap.
 */
import { test, expect } from '../../framework/fixtures';
import { oracle } from '../../framework/oracle';

const JOURNEY = [
  { op: 1, label: 'Normal Purchase', amount: 50.0, expect: -50.0 },
  { op: 2, label: 'Purchase with installments', amount: 30.25, expect: -30.25 },
  { op: 3, label: 'Withdrawal', amount: 20.0, expect: -20.0 },
  { op: 4, label: 'Credit Voucher', amount: 60.1, expect: 60.1 },
] as const;
const EXPECTED_NET_PAISE = JOURNEY.reduce((s, j) => s + Math.round(j.expect * 100), 0); // -4015

test.describe('cardholder journey', { tag: ['@pr', '@e2e'] }, () => {
  test('J-01 open account -> post one transaction of each operation type -> read account back', async ({ api, data }) => {
    oracle({ authority: 'contract', asserts: 'each step returns its documented success status and a schema-valid body', source: 'yaml L80-83, L107-110, L144-147', risks: ['R6'] });
    const doc = data.documentNumber();

    const accountId = await test.step('open account', async () => {
      const res = await api.createAccount(doc);
      expect(res.status).toBe(201);
      return res.body.account_id as number;
    });

    for (const j of JOURNEY) {
      await test.step(`post ${j.label} (op ${j.op}) of ${j.amount}`, async () => {
        const res = await api.createTransaction({ account_id: accountId, operation_type_id: j.op, amount: j.amount }, { idempotencyKey: data.idempotencyKey(`j${j.op}`) });
        expect(res.status).toBe(201);
      });
    }

    await test.step('read account back', async () => {
      const res = await api.getAccount(accountId);
      expect(res.status).toBe(200);
    });
  });

  test('J-02 resulting state: signs, types, attribution and net movement are correct', async ({ api, data, caps }) => {
    test.skip(!caps.stateful, 'money-state oracle needs a real store; on the mock every response is the spec example');
    oracle(
      { authority: 'hearsay', asserts: 'ops 1-3 negative/debit, op 4 positive/credit', source: 'H2; yaml L133', risks: ['R2'] },
      { authority: 'domain', asserts: `net movement == ${EXPECTED_NET_PAISE} paise, 4 rows, all on this account`, source: 'C1 R2/R3', risks: ['R2', 'R3'] },
    );
    const doc = data.documentNumber();
    const accountId = (await api.createAccount(doc)).body.account_id as number;
    const posted = [];
    for (const j of JOURNEY) {
      const res = await api.createTransaction({ account_id: accountId, operation_type_id: j.op, amount: j.amount }, { idempotencyKey: data.idempotencyKey(`j${j.op}`) });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ account_id: accountId, operation_type_id: j.op, amount: j.expect, type: j.expect < 0 ? 'debit' : 'credit' });
      posted.push(res.body);
    }
    expect((await api.getAccount(accountId)).body).toEqual({ account_id: accountId, document_number: doc });

    test.skip(!caps.transactionListing, 'read-back of state not possible: published contract has no transaction read path (CF-01)');
    const listed = (await api.listTransactions(accountId)).body.transactions as { transaction_id: number; amount: number }[];
    expect(listed.map((t) => t.transaction_id).sort()).toEqual(posted.map((p) => p.transaction_id).sort());
    expect(listed.reduce((s, t) => s + Math.round(t.amount * 100), 0)).toBe(EXPECTED_NET_PAISE);
    await test.info().attach('journey-ledger', { body: JSON.stringify({ accountId, doc, listed }, null, 2), contentType: 'application/json' });
  });
});
