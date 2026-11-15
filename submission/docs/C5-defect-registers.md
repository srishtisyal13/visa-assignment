# C5: Defect registers

Two registers, kept separate on purpose. Register 1 is **fact**: defects in a document I can read. Register 2 is **prediction**: bets about code I can't see, each falsifiable by a named test.

---

## Register 1: Contract defects (from C3a, prioritised)

Severity: **S1** blocks real money · **S2** major · **S3** minor. Classes per C3a §1. The S1 items are given in full report form; lower severities are summarised (full anchors in C3a).

### CD-1 · Exactly-once is unspecified and unverifiable (CF-01) · S1 · UNVERIFIABLE
- **Evidence:** `POST /transactions` parameters are a body only (L134-140). There is no path to read transactions or balances (`paths`, L64-162). `validator.spec.ts › CF-01/12` asserts no header params; `consumers:verify` → ledger "operation GET /accounts/1/transactions not in contract".
- **Expected:** a required `Idempotency-Key` header with replay/mismatch semantics, and a read path that lets "exactly one per key" be counted.
- **Actual:** idempotency exists only in hearsay (H3), and no consumer or tester can count what was written.
- **Business impact:** PISMO-4412 (double debit) cannot be proven fixed. Every release ships the R1 risk blind, and the ledger can't dedupe or reconcile.

### CD-2 · Nothing is required; `{}` is a valid transaction (CF-03) · S1 · UNSAFE
- **Evidence:** no `required` in any of the 5 definitions (L3-56). Prism returns 201 for `POST /transactions {}`. `validator.spec.ts › CF-03` passes `{}` both as a request and as a response.
- **Expected:** `required` on every field of every request and response.
- **Actual:** a provider omitting `amount` or `transaction_id` is contract-conformant.
- **Business impact:** silent field loss passes every contract check, and the ledger books incomplete rows (R6, R2).

### CD-3 · Negative and zero amounts are schema-valid despite "send a positive amount" (CF-02) · S1 · UNSAFE / INCONSISTENT
- **Evidence:** L23-25 has `type: number` and no minimum. L133 says "Send a positive amount."
- **Expected:** `minimum: 0, exclusiveMinimum: true`, and a documented 422.
- **Actual:** a client sending −50 conforms, and server behaviour is undefined.
- **Business impact:** with a multiply-by-sign implementation, a −50 purchase becomes a +50 credit (money created). See PD-2.

### CD-4 · Money as unconstrained float with unspecified unit and currency (CF-05, CF-18) · S1 · UNSAFE / AMBIGUOUS
- **Evidence:** L23-25 and L41-43 are `type: number` with no `maximum` or `multipleOf`, and there is no currency field. The unit exists only as hearsay (H1).
- **Expected:** integer minor units (or a decimal string) with a max and a currency, or at least `multipleOf: 0.01`, a maximum, and a documented unit.
- **Actual:** 10.005, 1e17 and 0.001 are all valid. Rupee-float and paise-int implementations both conform.
- **Business impact:** truncation and rounding errors, overflow, and unit confusion between consumers (R2).

### CD-5 · Operation type is an open integer (CF-07) and its sign mapping is prose (CF-19) · S1 · UNSAFE / AMBIGUOUS
- **Evidence:** L26-28 is a bare integer. L132-133 list 1–4 and say "correct sign" without defining it.
- **Expected:** `enum: [1,2,3,4]` and a documented sign per type.
- **Actual:** `99` is valid with an undefined sign, and the sign table lives in a standup comment.
- **Business impact:** unknown ops booked with a default sign; the ledger can't classify.

### CD-6 · No authentication or authorisation (CF-16) · S1 · UNSAFE
- **Evidence:** no `securityDefinitions` or `security` anywhere.
- **Expected:** a declared auth scheme per operation, and 401/403.
- **Actual:** an open contract.
- **Business impact:** anyone who can reach the host can post credit vouchers (R5).

### CD-7 · Audit guarantee unobservable (CF-21) · S1 · UNVERIFIABLE
- **Evidence:** no audit surface in the document. H6 is hearsay.
- **Expected:** an audit id in responses, or an audit read path or ops runbook; DB-level evidence of a single transaction.
- **Actual:** nothing.
- **Business impact:** R4 can't be signed off, and incident forensics depend on trust.

**S2 / S3 / S4 (summary):** CD-8 `type` free string (CF-08) · CD-9 installments: total vs per-installment undefined (CF-27) · CD-10 document_number unconstrained (CF-06) · CD-11 duplicate-document status missing (CF-10) · CD-12 unknown-account status undefined (CF-13) · CD-13 400 vs 422 semantics undefined (CF-15) · CD-14 unknown fields neither rejected nor ignored-by-contract (CF-29) · CD-15 no balance/statement (CF-22) · CD-16 no request-ID header (CF-12) · CD-17 missing 401/403/409/413/415/429/5xx (CF-14) · CD-18 `event_date` unformatted, time-zone undefined (CF-09) · CD-19 id formats/ranges (CF-04) · CD-20 contradictory examples (CF-20) · CD-21 localhost host, no schemes (CF-17) · CD-22 create/read-only lifecycle and no test-tenant marker (CF-11, S3) · CD-23 `handler.` prefixes leak implementation names (CF-23, S4).

---

## Register 2: Predicted implementation defects

**Basis:** the contract (the `handler.` prefixes and shapes point to a **Go service with swaggo-generated docs**, very likely `float64` amounts given `type: number`), the hearsay wording, and how services like this are usually built. Ranked by **money impact**. Each prediction has the test that confirms or refutes it, and the observation needed to run that test. Those that can be simulated over HTTP (PD-1, 2, 3, 5, 6, 7, 8, 10 [request-ID part], 12, 13) are implemented as faults in `tools/fault-fake`, and the mutation run shows the named test catches each one. PD-4, PD-9 and PD-11 are not modelled.

| Rank | Id | I bet that… | Why I believe it | Exact test | Observation needed |
|---|---|---|---|---|---|
| 1 | **PD-1** | **Idempotency is check-then-insert with no UNIQUE constraint on the key**, so concurrent same-key requests each write a row | PISMO-4412 happened. "Same key gets the original response" is usually implemented as *lookup → process → store response*, which is the classic race. | T1-01 at N=50 on staging | A count by key: needs `GET /accounts/{id}/transactions?idempotency_key=` (CF-01), or interim read-only SQL `SELECT count(*) … WHERE idempotency_key=$1` |
| 2 | **PD-2** | **Negative amounts are accepted and the sign is applied by multiplication**, so a −50 purchase books +50 | The schema has no minimum. "The server works out the sign" is cheapest as `amount * sign[op]`, and nobody writes the guard when the docs say "send positive". | AM-02 | The response `amount`/`type`, or the ledger row |
| 3 | **PD-3** | **Amounts are `float64` and converted with truncation (`int64(amount*100)`)**, so 0.29→28 paise, 4.35→434 | `type: number` from swaggo means `float64`. H1 says minor units stored, which means a conversion exists, and truncation is the default int cast in Go. | TX-10 (0.29, 4.35, 19.99) | The response amount; better, the stored minor-unit value |
| 4 | **PD-7** | **Idempotency replay is body-blind**: the same key with a different amount returns the first response with 201 | H3's own wording ("send the same key, you get the original response back") describes exactly this. A request hash is an extra step that rarely ships in v1. | ID-02 | Status of the second call, plus the count/amount by key |
| 5 | **PD-8** | **The idempotency key is optional**; unkeyed requests are processed unprotected | The contract doesn't declare the header, so it can't be required by generated validation. Typical middleware is `if key != "" {…}`. | ID-03 | Status of an unkeyed POST |
| 6 | **PD-5** | **Unknown `operation_type_id` gets a default sign**: Go map lookup gives zero value 0 (amount × 0 = **₹0 row**), or `default:` falls to credit | No enum; sign from a `map[int]int` or `switch` | RI-02 (0, 5, 99, −1, 2^31) | Status and, if 201, the stored amount |
| 7 | **PD-4** | **No maximum: 1e17 overflows int64 paise or loses precision; `9007199254740993` rounds silently** | float64 × 100 → int64 | AM-05, AM-06 | Status, response amount vs sent |
| 8 | **PD-9** | **Zero (and sub-paisa 0.004) creates a ₹0.00 transaction** | No minimum; rounding happens after validation, if there is validation at all | AM-01, AM-10 | Status, response amount |
| 9 | **PD-11** | **The audit row is written outside the business transaction** (after commit, or via a separate repo/connection), so it can diverge under failure, and replays may write duplicate audit rows | "Same DB transaction" is easy to claim and hard to keep when audit is a separate repository/service layer | Fault-injection test in the service repo: abort after the business insert and assert the audit row is absent, and vice versa; replay a key and count audit rows | DB access in staging, or an audit read endpoint (OQ-12) |
| 10 | **PD-6** | **No UNIQUE on `document_number`**, or uniqueness is check-then-insert: duplicates under concurrency | Same pattern as PD-1, and the contract has no 409 | AC-20, AC-21 (10 concurrent) | Count of 201s |
| 11 | **PD-12** | **Unknown request fields are silently ignored** (`json.Decoder` default), so `{"currency":"USD"}` is dropped | Go default, and the contract is silent (CF-29) | XC-15 (`currency:"USD"` → 400/422, nothing created) | Status |
| 12 | **PD-10** | **Router-level 404/405 bypass the JSON error handler and request-ID middleware**: plain-text `Method Not Allowed`, no request ID | Go `ServeMux` writes `text/plain` 405s itself; middleware is often mounted per route | CT-20, XC-01 | Content-type, body, headers |
| 13 | **PD-13** | **`document_number` validation is length-only** (or `strconv` digits): letters, spaces or `١٢٣…` accepted, or 14 digits overflow an int32 parse | "Something like 10 to 14 digits" is a len() check | AC-11, AC-12 | Status |

**What would change my mind:** PD-1, PD-7 and PD-8 all fall if the dev shows a migration with `UNIQUE(idempotency_key)` and a request-hash column. PD-3 and PD-4 fall if `amount` is a `decimal`/string type in the Go struct. Those artefacts are the cheapest "observation" of all, so I would ask for them on day one.
