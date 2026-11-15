# C4: Test design and executable suite

**Stack:** TypeScript + Playwright Test (`APIRequestContext`). One runner serves the API suite, the concurrency guardrail and the E2E journey. T3 requires Playwright anyway, and a single toolchain is one less thing for the squad to learn.

**Run:** `npm test` (mock, starts Prism itself) · `TARGET=fake npm test` (behaviour vs fault-fake) · `TARGET=staging STAGING_URL=… npm test` (real service, no code change).

## 1. Every case states its oracle

Each test calls `oracle({authority, asserts, source, risks})`. The annotation appears in the HTML report next to the verdict.

| Authority | Meaning | Example source |
|---|---|---|
| `contract` | The YAML says so | `yaml L84-87` |
| `hearsay` | The engineer said so (H1–H6). Not binding. | `H2` |
| `domain` | What a money system must do | `C1 R2` |
| `assumption` | My call, pending an answer | `OQ-6` |

Many cases carry **two** oracles (e.g. *contract says positive; hearsay says which sign*). Where a case's only oracle is `assumption`, it is linked to an open question: the test is a placeholder for an answer, and I say so.

## 2. Case catalogue

| Area | File | Cases | Runs on mock? |
|---|---|---|---|
| Contract conformance (shapes, types, 405) | `tests/contract/conformance.spec.ts` | CT-01..03, CT-10..13, CT-20 ×4 | **Yes** (CT-20 = expected-fail, MOCK-1) |
| Account lifecycle, `document_number` boundaries, duplicates | `tests/functional/accounts.spec.ts` | AC-01..04, AC-10..12, AC-20..21 | Skipped (behavioural) |
| Sign / `type` / round-trip per operation type | `tests/functional/transactions.spec.ts` | TX-01..04, TX-10 ×6 | Skipped |
| Amount edge cases | `tests/functional/amounts.spec.ts` | AM-01..11 (reject), AM-20..22 (accept) | Skipped |
| Referential integrity | `tests/functional/referential.spec.ts` | RI-01, RI-02 ×5, RI-03 | Skipped |
| Idempotency (sequential) | `tests/functional/idempotency.spec.ts` | ID-01..04 | Skipped |
| Cross-cutting | `tests/functional/cross-cutting.spec.ts` | XC-01..03 (request ID), XC-10..15 | XC-10..13 **yes** |
| Concurrency guardrail (T1) | `tests/incident/pismo-4412.spec.ts` | T1-01, T1-02 | T1-01 yes (proposed-contract mock) |
| E2E journey (T3) | `tests/e2e/cardholder-journey.spec.ts` | J-01, J-02 | J-01 yes |
| Generated negative contract cases (T4) | `tests/generated/` | GEN-001..019 | Yes |
| Validator self-tests | `tests/unit/validator.spec.ts` | 12 | Yes (no network) |

**Results today:** mock **56 passed (4 as declared expected-failures, CT-20 ×4 for MOCK-1; 8 are the T2 SLO-gate unit tests) / 63 skipped / 0 failed**. Fake **119/119 passed**. Mutation **12/12 faults killed** (baseline 80/80).

### Amount edge cases: what *should* happen vs what the contract *promises*

The contract promises nothing beyond `type: number` (L23-25) and the prose "Send a positive amount" (L133). That prose is an instruction to the client, not a promise about the server.

| Case | Input | Should | Contract promises |
|---|---|---|---|
| AM-01 | `0` | 422; zero-value records are noise or audit holes | nothing (0 is a valid number) |
| AM-02 | `-50` | 422; never accept a client sign (else −50 purchase = +50 credit) | prose only; **schema accepts** (CF-02) |
| AM-03 | `-0` | reject like zero | nothing |
| AM-04 | `10000000.01` | 422 at a business maximum (OQ-3) | nothing (no `maximum`) |
| AM-05 | `1e17` | 422; never overflow int64 paise | nothing |
| AM-06 | `9007199254740993` | reject; must not round silently to …992 | nothing |
| AM-07 | `1e400` | 400/422, no 5xx | nothing |
| AM-08 | `10.005` | 422 rather than an undocumented rounding | nothing (no `multipleOf`) |
| AM-09 | `0.001` | 422; below the smallest unit (H1) | nothing |
| AM-10 | `0.004` | 422; must not create a ₹0.00 transaction | nothing |
| AM-11 | `1e-7` | 422 | nothing |
| AM-20..22 | `0.01`, `5e1`, `50.10` | accept, round-trip exactly | `type: number` (valid JSON) |
| TX-10 | `0.01, 0.1, 0.29, 4.35, 19.99, 1234567.89` | round-trip **exactly** (chosen because ×100 is inexact in binary float) | nothing about unit (H1 hearsay) |

## 3. Traceability matrix

The full matrix is **generated from the code** (`npm run matrix` → `docs/C4-traceability-matrix.generated.md`, 75 cases). It reads each case's oracle risk ids and joins them with the mutation results. **The build fails if any case retires no risk.** The table below is the hand-written view of the *specific defect* each key case catches, which a generator can't write:

| Case | Risk | Specific defect it would catch | CI gate |
|---|---|---|---|
| T1-01 | R1 | Check-then-insert idempotency race: N concurrent same-key requests write >1 row (PD-1). *The only case that kills `idem-race`.* | PR (N=25), nightly (50×5), pre-release (200×20) |
| T1-02 | R1 | "Dedup" implemented as dropping concurrent writes (would make T1-01 pass for the wrong reason) | PR / nightly |
| ID-01 | R1 | Sequential retry writes a second row / replay body differs | PR |
| ID-02 | R1, R2 | Body-blind key reuse: a ₹1000 request replays a ₹10 receipt and the client believes it was charged ₹1000 (PD-7) | PR |
| ID-03 | R1 | Key optional: unkeyed requests processed with no retry protection (PD-8) | PR |
| ID-04 | R3 | Global key scope returns another account's transaction | PR |
| TX-01..04 | R2 | Sign table wrong or missing for an op (e.g. credit voucher stored as debit); `type` mislabelled | PR |
| TX-10 | R2 | `int(amount*100)` truncation: 0.29→0.28, 4.35→4.34, 19.99→19.98 (PD-3) | PR |
| AM-02 | R2 | Negative accepted and sign multiplied: −50 purchase books +50 (PD-2) | PR |
| AM-01/09/10 | R2 | Zero or sub-paisa amounts create ₹0.00 rows (PD-9) | PR |
| AM-04..07 | R2 | No max: overflow/wrap, float64 precision loss, 5xx on Infinity (PD-4) | PR |
| AM-08 | R2 | Silent rounding of 3-dp amounts (direction undocumented) | PR |
| RI-01 | R3 | Transaction accepted for a non-existent account (FK missing), or a 5xx instead of 4xx | PR |
| RI-02 | R3, R2 | Unknown op type booked with a default sign or zero (PD-5) | PR |
| RI-03 | R3 | Cross-wiring of `account_id` under concurrency | PR |
| AC-11/12 | R7 | Validation is length-only or absent: letters, punctuation, whitespace, Arabic-Indic digits accepted (PD-13) | PR |
| AC-20/21 | R7 | No UNIQUE on `document_number`, or check-then-insert race (PD-6) | PR / nightly |
| AC-02 | R7 | `document_number` parsed as a number somewhere, dropping leading zeros | PR |
| AC-04 | R8 | `strconv`/int overflow on `2^63` path ids gives a 5xx | PR |
| XC-01..03 | R9 | Request-ID middleware bypassed on router-level 404/405 (PD-10); IDs not unique or not echoed | PR |
| XC-10..14 | R8 | Unbounded body read; parse errors give 500; wrong content-type processed | PR / nightly |
| XC-15 | R2 | `{"currency":"USD"}` silently dropped and booked as INR (PD-12) | PR |
| CT-01..03 | R6 | Provider drops or retypes a field consumers rely on (only detectable as drift while v1 has no `required`) | PR (mock = harness), nightly (staging = real) |
| CT-20 | R6, R8 | 405 not JSON / not `errorResponse` (Go `ServeMux` writes `text/plain`, PD-10) | PR |
| J-01/J-02 | R2, R3, R6 | A wiring break across the full journey; net movement ≠ −40.15 | PR |

**Cut or justified.**
- *Cut:* exhaustive document-number formats (CPF masks, every Unicode digit class). Two representative invalid classes suffice until OQ-4 is answered.
- *Cut:* GET-account variants beyond the four boundary ids.
- *Justified despite looking trivial:* CT-01..03 retire nothing on the mock. They exist because on staging they are the only check that a field consumers rely on is still present, since v1 marks nothing required.
- *Justified despite an `assumption` oracle:* ID-02/ID-04 and AC-20's status code. They encode the behaviour I will argue for (OQ-5, OQ-6), and the answer changes one literal.
