# C3a: Contract audit: findings register

**Audited:** `contract/transactions-service.v1.yaml` (Swagger 2.0, `info.version: "1.0"`, 163 lines). Anchors are `L<line>` in that file, plus a JSON pointer where useful. Every finding marked *(machine-checked)* is asserted by a test in `tests/unit/validator.spec.ts` or by `npm run consumers:verify`. If the provider fixes the contract, those tests go red and this register must be updated.

## 1. Classification scheme

I classify by **what the defect stops us from doing**, because that decides the remedy, the owner and whether it blocks release:

| Class | Meaning | Remedy and owner | Effect on testing |
|---|---|---|---|
| **UNSAFE** | The contract *permits* behaviour that loses, creates or misdirects money | Schema constraint + server validation (dev); **blocks release** | Tests exist but their oracle is domain, not contract |
| **UNVERIFIABLE** | A guarantee is claimed (prose or hearsay) but *cannot be observed* through the API | Contract addition for observability (dev + QA); **blocks sign-off** | The test can't be written to pass. It must fail as "not verifiable". |
| **AMBIGUOUS** | Two reasonable implementations both conform | Decision by PO/dev (open question) | Oracle is an *assumption*, so the test is weak until answered |
| **INCONSISTENT** | The contract contradicts itself, or its examples contradict its rules | Fix the document (dev) | Mocks built from it behave inconsistently |
| **INCOMPLETE** | Behaviour that must exist is undocumented (codes, headers, paths) | Document it (dev) | Real responses will "violate" the contract, which is noise in the drift checks |
| **HYGIENE** | No runtime consequence | Backlog | None |

**Why this carving is useful.** A severity-only list ("High/Med/Low") tells you *how bad* but not *what to do next* or *who does it*. The two classes that matter most here, UNSAFE and UNVERIFIABLE, need different people and different fixes. UNSAFE needs validation code; UNVERIFIABLE needs a new endpoint or header. Merging them hides the most important insight of this audit: **the money guarantees are not just unenforced, they are unobservable.** The class also predicts how a test behaves (domain oracle / fail-as-unverifiable / assumption), which keeps the test suite honest about its own authority. Severity is a separate axis: **S1** blocks real money, **S2** major, **S3** minor, **S4** trivial.

## 2. Register

IDs stay fixed once other documents reference them, so the numbering has gaps (there is no CF-24 to CF-26 or CF-28).

| Id | Class | Sev | Anchor | Finding |
|---|---|---|---|---|
| **CF-01** | UNVERIFIABLE | S1 | L134-140 (only a `body` param); `paths` L64-162 (no read path for transactions) | **Exactly-once is neither specified nor observable.** No idempotency header is declared on `POST /transactions`, and there is no endpoint to list or count transactions, nor any balance. H3 is not contractual, and "exactly one transaction" (PISMO-4412) cannot be verified via the API. *(machine-checked)* |
| **CF-02** | UNSAFE (+INCONSISTENT) | S1 | L23-25 vs L133 | `amount` has no `minimum`/`exclusiveMinimum`. The prose says "Send a positive amount" but the schema accepts `0`, `-50`. The machine-readable contract contradicts its own prose, and nothing says what the server does with a negative. *(machine-checked)* |
| **CF-03** | UNSAFE | S1 | L3-56 (no `required` in any definition) | **No field is required anywhere**, in requests or responses. `{}` is a valid create-transaction request *and* a valid 201 response. The provider can omit `amount` or `transaction_id` and still conform. *(machine-checked; Prism returns 201 for `{}`)* |
| **CF-05** | UNSAFE | S1 | L23-25, L41-43 | Money as unconstrained JSON `number`: no `maximum`, no `multipleOf`/decimal places, no format. Invites float storage, truncation (0.29→0.28), overflow, and silent rounding of 10.005. Values beyond 2^53 cannot round-trip in most JSON clients. *(machine-checked)* |
| **CF-16** | UNSAFE | S1 | top level (no `securityDefinitions`/`security`) | **No authentication or authorisation** is declared for any operation, including posting credits. |
| **CF-18** | AMBIGUOUS | S1 | L23-25, L60-61 | **Unit and currency are unspecified.** H1 says rupees in, minor units stored. The contract says nothing, and there is no `currency` field. Both a paise-integer and a rupee-float implementation conform. |
| **CF-19** | AMBIGUOUS | S1 | L133 | "The server applies the **correct** sign" never says which sign for which op. The mapping (1–3 negative, 4 positive) exists only in hearsay H2 and one example (L42/L54). |
| **CF-07** | UNSAFE | S1 | L26-28, L132 | `operation_type_id` is a bare integer. The valid set 1–4 lives only in description prose, so `99` is schema-valid and its sign is undefined. *(machine-checked)* |
| **CF-21** | UNVERIFIABLE | S1 | whole document | H6 (audit row in the same DB transaction) has no observable surface: no audit endpoint, no audit id in responses. |
| **CF-08** | AMBIGUOUS | S2 | L53-55 | `type` is a free string with one example, `debit`. Its value set (credit? reversal?) and relation to sign are undefined, and the ledger consumer can't switch on it safely. *(machine-checked)* |
| **CF-27** | AMBIGUOUS | S2 | L132 (op 2) | "Purchase with installments" has no installment count field, and it is undefined whether `amount` is the total or one installment. |
| **CF-06** | AMBIGUOUS | S2 | L14-16 | `document_number`: no `pattern`, `minLength`, `maxLength`. H4's "10 to 14 digits" is not contractual. |
| **CF-10** | INCOMPLETE | S2 | L79-91 | No status for a duplicate document number (409). Uniqueness itself is unstated. |
| **CF-13** | AMBIGUOUS | S2 | L143-159 | The response for a non-existent account on `POST /transactions` is undefined: 422 by elimination? 400? (No 404 is declared.) |
| **CF-15** | AMBIGUOUS | S2 | L148-159 | Both 400 and 422 are declared on `POST /transactions` with only HTTP reason phrases. Which errors map to which is undefined. *(Found by running: Prism answers 422 for an empty body.)* |
| **CF-29** | AMBIGUOUS | S2 | L18-29 (no `additionalProperties`) | Unknown request fields are neither rejected nor declared ignored. `{"amount":50,"currency":"USD"}` is valid, so a client's currency is silently dropped. |
| **CF-22** | INCOMPLETE | S2 | `paths` | No balance and no account statement, so consumers can't reconcile (ledger need; see C3b §2). |
| **CF-12** | INCOMPLETE | S2 | all `responses` (no `headers`) | No request-ID header declared (H5). No response headers at all. *(machine-checked)* |
| **CF-14** | INCOMPLETE | S2 | L79-91, L106-122, L143-159 | No 401/403 (see CF-16), 409, 413, 415, 429, 500 or 503. Real servers emit these, so every one is guaranteed drift. *(Prism already returns 415-shaped violations as 400.)* |
| **CF-09** | AMBIGUOUS | S3 | L44-46 | `event_date` is a bare string: no `format: date-time`, no timezone rule, no definition (request time? commit time?). |
| **CF-04** | AMBIGUOUS | S3 | L5-7, L20-22, L50-52, L98-103 | Ids are `integer` with no `format` (int32/int64) and no minimum, so `0`, `-1`, `2^63` are all valid path ids. |
| **CF-11** | INCOMPLETE | S3 | `paths` | Account lifecycle is create/read only (no close/suspend), and there is no test-tenant marker, which forces data-by-namespace in shared staging. |
| **CF-20** | INCONSISTENT | S3 | L24 vs L42; L33 | Examples contradict each other. The request example is `amount: 50, op 1` but the response example is `-100.5`. The single error example `"account not found"` is attached to every 400/405, so the mock returns "account not found" for a malformed document number. |
| **CF-17** | HYGIENE (security-adjacent) | S3 | L57, L1 | `host: localhost:8080`, no `schemes` (TLS unstated), `basePath: /` with no version segment. |
| **CF-23** | HYGIENE | S4 | L3, L12, … | `handler.` prefixes leak implementation package names (swaggo); no `operationId`s for codegen. |

## 3. Hearsay vs contract

| # | Hearsay | Contract | Verdict | Consequence |
|---|---|---|---|---|
| H1 | Rupees in, smallest unit stored | `type: number` only (L23-25); examples 50 / -100.5 | **Silent** | Unit, precision and rounding are unenforceable (CF-05, CF-18). The schema also accepts amounts finer than a paisa (e.g. `0.001`), which H1's smallest-unit storage cannot hold; what the server does then is undefined (tested by AM-09, AM-10) |
| H2 | Positive in; server signs: purchases/withdrawals negative, credits positive | Prose L133 **commits** to "send positive; server applies the correct sign". It does **not** say which sign, and the **schema contradicts** "positive" (no minimum) | **Partly committed, internally contradicted** | CF-02, CF-19 |
| H3 | Idempotency header; same key returns the original response | No header parameter anywhere | **Silent** | CF-01; the PISMO-4412 guarantee is not contractual |
| H4 | Document numbers validated, ~10–14 digits | `type: string` only; example is 11 digits (consistent) | **Silent** | CF-06 |
| H5 | Every response has a request ID header | No response headers declared | **Silent** | CF-12; the mock generated from the contract emits none, so in the mock's world H5 is *false* |
| H6 | Audit row in the same DB transaction | Nothing | **Silent and unobservable** | CF-21 |

**Reading:** no hearsay claim is outright contradicted by the contract. But **five of the six claims that the safety case rests on are not in it**, and the only one that is (H2) is contradicted by the contract's own schema. The service's safety case is currently oral.
