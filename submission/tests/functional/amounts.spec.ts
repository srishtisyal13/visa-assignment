/**
 * Amount edge cases, where money bugs live.
 *
 * For every case the oracle states BOTH what should happen (domain) and what
 * the contract actually promises. For all of them the v1 contract promises
 * nothing beyond `type: number` (yaml L23-25) and the prose "Send a positive
 * amount" (L133), which tells the client what to do but not what the server
 * does when the client does not.
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

interface AmountCase {
  id: string;
  label: string;
  amount: number | string;
  rawJson?: boolean;
  should: string;
  contractPromises: string;
  source: string;
}

const REJECT: AmountCase[] = [
  { id: 'AM-01', label: 'zero', amount: 0, should: 'reject 422: a zero-value financial record is noise at best and an audit hole at worst', contractPromises: 'nothing; 0 is a valid `number`', source: 'CF-02; OQ-2' },
  { id: 'AM-02', label: 'negative', amount: -50, should: 'reject 422: never accept a sign from the client (else -50 purchase = +50 credit)', contractPromises: 'prose only: "Send a positive amount" (L133); no `minimum`', source: 'CF-02; H2; C5 PD-2' },
  { id: 'AM-03', label: 'negative zero', amount: '-0', rawJson: true, should: 'reject like zero', contractPromises: 'nothing', source: 'CF-02' },
  { id: 'AM-04', label: 'above any plausible limit (1e7 + 0.01)', amount: 10_000_000.01, should: 'reject 422 at a business maximum', contractPromises: 'nothing; no `maximum`', source: 'CF-05; OQ-3' },
  { id: 'AM-05', label: 'beyond int64 paise (1e17)', amount: 1e17, should: 'reject 422, never overflow/wrap into a different value', contractPromises: 'nothing', source: 'CF-05; C5 PD-4' },
  { id: 'AM-06', label: 'beyond IEEE-754 safe integer (9007199254740993)', amount: '9007199254740993', rawJson: true, should: 'reject; must not silently round to …992', contractPromises: 'nothing', source: 'CF-05' },
  { id: 'AM-07', label: 'float overflow (1e400 -> Infinity in most parsers)', amount: '1e400', rawJson: true, should: 'reject 400/422, no 5xx', contractPromises: 'nothing', source: 'CF-05' },
  { id: 'AM-08', label: 'high precision (10.005, 3 dp)', amount: 10.005, should: 'reject 422 rather than silently round (which way? banker\'s? half-up?)', contractPromises: 'nothing; no `multipleOf`, no decimal places', source: 'CF-05; OQ-1' },
  { id: 'AM-09', label: 'sub-unit (0.001 rupee = 0.1 paisa)', amount: 0.001, should: 'reject 422: below the smallest storable unit (H1)', contractPromises: 'nothing', source: 'H1; CF-05' },
  { id: 'AM-10', label: 'sub-unit that rounds to zero (0.004)', amount: 0.004, should: 'reject 422: must not create a 0.00 transaction', contractPromises: 'nothing', source: 'H1; CF-02' },
  { id: 'AM-11', label: 'exponent notation for a sub-unit (1e-7)', amount: '1e-7', rawJson: true, should: 'reject 422', contractPromises: 'nothing', source: 'CF-05' },
];

const ACCEPT: AmountCase[] = [
  { id: 'AM-20', label: 'smallest unit (0.01)', amount: 0.01, should: 'accept; round-trips as 0.01', contractPromises: 'nothing explicit', source: 'H1' },
  { id: 'AM-21', label: 'integer-valued float in exponent form (5e1)', amount: '5e1', rawJson: true, should: 'accept as 50 (valid JSON number)', contractPromises: 'type: number (JSON grammar allows it)', source: 'yaml L25' },
  { id: 'AM-22', label: 'trailing zeros (50.10)', amount: '50.10', rawJson: true, should: 'accept as 50.1', contractPromises: 'type: number', source: 'yaml L25' },
];

test.describe('amount edge cases: must be rejected', { tag: ['@pr', '@functional', '@p0'] }, () => {
  for (const c of REJECT) {
    test(`${c.id} ${c.label} is rejected and creates nothing`, async ({ api, account, data, caps }) => {
      oracle(
        { authority: 'domain', asserts: `SHOULD: ${c.should}`, source: c.source, risks: ['R2'] },
        { authority: 'contract', asserts: `CONTRACT PROMISES: ${c.contractPromises}`, source: 'yaml L23-25, L133', risks: ['R2'] },
      );
      const key = data.idempotencyKey(c.id);
      const res = c.rawJson
        ? await api.raw({ method: 'POST', path: '/transactions', data: `{"account_id":${account.account_id},"operation_type_id":1,"amount":${c.amount}}`, headers: { [caps.idempotencyHeader]: key } })
        : await api.createTransaction({ account_id: account.account_id, operation_type_id: 1, amount: c.amount }, { idempotencyKey: key });
      expect([400, 422], `got ${res.status}: ${res.text}`).toContain(res.status);
      if (caps.transactionListing) {
        const list = await api.listTransactions(account.account_id);
        expect(list.body.transactions, 'a rejected request must not leave a transaction behind').toHaveLength(0);
      }
    });
  }
});

test.describe('amount edge cases: must be accepted', { tag: ['@pr', '@functional'] }, () => {
  for (const c of ACCEPT) {
    test(`${c.id} ${c.label} is accepted`, async ({ api, account, data, caps }) => {
      oracle(
        { authority: 'domain', asserts: `SHOULD: ${c.should}`, source: c.source, risks: ['R2'] },
        { authority: 'contract', asserts: `CONTRACT PROMISES: ${c.contractPromises}`, source: 'yaml L23-25', risks: ['R2'] },
      );
      const res = c.rawJson
        ? await api.raw({ method: 'POST', path: '/transactions', data: `{"account_id":${account.account_id},"operation_type_id":4,"amount":${c.amount}}`, headers: { [caps.idempotencyHeader]: data.idempotencyKey(c.id) } })
        : await api.createTransaction({ account_id: account.account_id, operation_type_id: 4, amount: c.amount }, { idempotencyKey: data.idempotencyKey(c.id) });
      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(Number(c.amount));
    });
  }
});
