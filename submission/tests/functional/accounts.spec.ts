/**
 * Account lifecycle and document_number validation.
 *
 * The v1 contract says only `document_number: string` (yaml L14-16). Length,
 * charset and uniqueness come from hearsay H4 and domain reasoning, so every
 * expectation below is marked with that weaker authority. The mock cannot
 * oracle any of it, so these cases are skipped on stateless targets.
 */
import { test, expect } from '../../framework/fixtures';
import { oracle, NEEDS_REAL_SERVICE } from '../../framework/oracle';

test.beforeEach(({ caps }) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE));

test.describe('account lifecycle', { tag: ['@pr', '@functional'] }, () => {
  test('AC-01 created account round-trips its document_number exactly', async ({ api, data }) => {
    oracle({ authority: 'domain', asserts: 'GET returns the same id and byte-identical document_number that POST stored', source: 'yaml L69 ("with the given document number")', risks: ['R7'] });
    const doc = data.documentNumber();
    const created = await api.createAccount(doc);
    expect(created.status).toBe(201);
    expect(created.body.document_number).toBe(doc);
    const read = await api.getAccount(created.body.account_id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ account_id: created.body.account_id, document_number: doc });
  });

  test('AC-02 leading zeros are preserved (document_number is a string, not a number)', async ({ api, data }) => {
    oracle({ authority: 'contract', asserts: 'string type means "00…" is not normalised away', source: 'yaml L16 type: string', risks: ['R7'] });
    const doc = '0' + data.documentNumber(10);
    const created = await api.createAccount(doc);
    expect(created.status).toBe(201);
    expect((await api.getAccount(created.body.account_id)).body.document_number).toBe(doc);
  });

  test('AC-03 GET of a non-existent account returns 404 errorResponse', async ({ api }) => {
    oracle({ authority: 'contract', asserts: '404 documented for GET /accounts/{id}', source: 'yaml L115-118', risks: ['R3'] });
    const res = await api.getAccount(2_000_000_000);
    expect(res.status).toBe(404);
  });

  for (const id of ['0', '-1', '9223372036854775808', '1.5']) {
    test(`AC-04 GET /accounts/${id} is a clean 400/404, never 5xx`, async ({ api }) => {
      oracle({ authority: 'domain', asserts: 'boundary/overflow ids never produce 5xx', source: 'yaml L103 type: integer (no format/range: CF-04)', risks: ['R8'] });
      const res = await api.getAccount(id);
      expect([400, 404]).toContain(res.status);
    });
  }
});

test.describe('document_number validation (hearsay H4: "something like 10 to 14 digits")', { tag: ['@pr', '@functional'] }, () => {
  for (const len of [10, 11, 14]) {
    test(`AC-10 ${len} digits is accepted (inside boundary)`, async ({ api, data }) => {
      oracle({ authority: 'hearsay', asserts: `${len}-digit document accepted`, source: 'H4; OQ-4', risks: ['R7'] });
      expect((await api.createAccount(data.documentNumber(len))).status).toBe(201);
    });
  }
  for (const len of [9, 15]) {
    test(`AC-11 ${len} digits is rejected with 400 (just outside boundary)`, async ({ api, data }) => {
      oracle({ authority: 'hearsay', asserts: `${len}-digit document rejected 400`, source: 'H4; OQ-4', risks: ['R7'] });
      expect((await api.createAccount(data.documentNumber(len))).status).toBe(400);
    });
  }
  const invalid: [string, unknown][] = [
    ['empty string', ''],
    ['letters', '12345abcde1'],
    ['punctuation (formatted CPF)', '123.456.789-00'],
    ['whitespace padded', ' 12345678901 '],
    ['unicode digits', '١٢٣٤٥٦٧٨٩٠١'],
    ['null', null],
    ['missing field', undefined],
  ];
  for (const [label, value] of invalid) {
    test(`AC-12 ${label} is rejected with 400`, async ({ api }) => {
      oracle({ authority: 'hearsay', asserts: 'non-digit / absent document rejected with documented 400', source: 'H4; yaml L84-87; CF-03 (field not required)', risks: ['R7'] });
      const res = value === undefined ? await api.raw({ method: 'POST', path: '/accounts', data: {} }) : await api.createAccount(value);
      expect(res.status).toBe(400);
    });
  }
});

test.describe('duplicates', { tag: ['@pr', '@functional'] }, () => {
  test('AC-20 second account with the same document_number is rejected and no new id is issued', async ({ api, data }) => {
    oracle(
      { authority: 'domain', asserts: 'one cardholder identity -> one account; duplicate is a 4xx', source: 'C1 R7; OQ-5 (status code: 409 proposed, v1 only has 400)', risks: ['R7'] },
      { authority: 'assumption', asserts: 'status is 400 or 409', source: 'OQ-5', risks: ['R7'] },
    );
    const doc = data.documentNumber();
    expect((await api.createAccount(doc)).status).toBe(201);
    const dup = await api.createAccount(doc);
    expect([400, 409]).toContain(dup.status);
    expect(dup.body).not.toHaveProperty('account_id');
  });

  test('AC-21 concurrent duplicate creates yield exactly one account', { tag: ['@nightly'] }, async ({ api, data }) => {
    oracle({ authority: 'domain', asserts: 'uniqueness holds under a race (DB constraint, not check-then-insert)', source: 'C1 R7; C5 PD-6', risks: ['R7'] });
    const doc = data.documentNumber();
    const results = await Promise.all(Array.from({ length: 10 }, () => api.createAccount(doc)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status < 500)).toBe(true);
  });
});
