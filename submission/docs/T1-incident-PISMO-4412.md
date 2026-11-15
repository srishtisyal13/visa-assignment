# T1: Incident PISMO-4412: double debit under a retry storm

**Summary.** During a client's retry storm, some customers were debited twice on `POST /transactions`, despite an idempotency mechanism. **My finding:** through the published contract, "it can't happen again" **cannot be verified**. I've written the guardrail test anyway, wired it to run unchanged on mock, fake and staging, and specified the smallest contract change that makes it able to pass. Until that change ships, my sign-off position on PISMO-4412 is **blocked**.

## 1. Verification design

**Test:** `tests/incident/pismo-4412.spec.ts` · **Run:** `npm run test:incident` (mock) · `TARGET=fake npm run test:incident` · `TARGET=staging STAGING_URL=… npm run test:incident`

**T1-01: N concurrent identical requests with one key give exactly one transaction**
1. Fresh account (the test's own isolation unit).
2. One key `K`, one body (`op 1, ₹12.34`).
3. **Start barrier:** all N promises are built, then released in the same tick, so they overlap in the server's check-then-act window. `T1_CONCURRENCY` defaults to 25; nightly uses 50, pre-release 200. `T1_ROUNDS` repeats.
4. Assertions, in order of strength:
   - (a) no 5xx;
   - (b) every reply is 201 (original or replay) or 409 (in flight);
   - (c) every 201 names the same `transaction_id`. Necessary but **not sufficient**, see §2;
   - (d) **THE ORACLE: `GET /accounts/{id}/transactions?idempotency_key=K` returns exactly 1**;
   - (e) on stateful targets, the account's net movement is exactly −1234 paise.
5. A status histogram is attached to the report for triage.

**T1-02 (control): N concurrent requests with distinct keys give N transactions.** Without it, a server that "deduplicates" by dropping concurrent writes would pass T1-01.

**Same test, three targets, three meanings:**

| Target | Result | What it means |
|---|---|---|
| Prism, **proposed** v1.1 contract | green | The harness works: barrier, header, read-back, assertions. The count is the spec example, so **not evidence**. |
| Fault-fake, `FAULTS=idem-race` | **red**: 25 writes for one key | The test **can** detect the defect class. Of the 80 tests in the mutation run, it is the **only** one that kills `idem-race`; every sequential idempotency test passes against it. |
| Staging on the **published** v1 contract | **red: "NOT VERIFIABLE … sign-off BLOCKED"** | Correct. See §2. (Demonstrated by pointing `TARGET=staging` at a stand-in without the read capability.) |

## 2. The observability problem (the important part)

**Can "exactly one" be verified through the published API? No.**
- `POST /transactions` declares only a body (L134-140). **There is no idempotency header in the contract at all**, so the mechanism under test is not even a published behaviour.
- `paths` (L64-162) contains **no way to read transactions**: no list, no get-by-id, no balance, no statement. The only evidence of a write is the reply to the request that caused it.
- **Replay equality is not proof.** If N requests return the same `transaction_id`, the server may still have inserted N rows and then served the first stored response to everyone. That is the typical failure when the response cache is keyed correctly but the insert isn't guarded (hypothesis H-A, §3). The customer's statement would show N debits while every API reply looked perfect. Assertion (c) cannot tell these apart. Only a count can.

**What this means for sign-off.** I cannot sign off PISMO-4412 as fixed on API evidence, and I won't sign off on reply-equality evidence, because that is precisely the evidence that looked fine during the incident. Options, in order of preference:
1. **Ship the minimum contract change** (below). Then T1-01 runs green on staging, and the release is unblocked for R1.
2. **Interim waiver:** a one-off, read-only DB query on staging by the dev or DBA after a T1-01 storm (`SELECT idempotency_key, count(*) … GROUP BY 1 HAVING count(*) > 1` must return zero rows), plus the PD-1 artefacts (migration with `UNIQUE`). This is accepted by the EM/PO in writing **for one release only**, because it is not a repeatable guardrail.
3. Neither: **no-go** for R1.

**Minimum contract change** (the parts of `contract/proposed/transactions-service.v1.1-proposed.yaml` tagged `x-qa-change: CF-01`; the rest of that file proposes fixes for the other C3a findings and is not needed for T1):
```yaml
parameters:
  IdempotencyKey: { name: Idempotency-Key, in: header, required: true, type: string, maxLength: 255 }
paths:
  /transactions:
    post:
      parameters: [ { $ref: '#/parameters/IdempotencyKey' }, … ]
      responses:
        "201": { headers: { Idempotent-Replayed: { type: boolean } }, … }   # original vs replay
        "409": in flight with this key
        "422": key reused with a different body
  /accounts/{accountId}/transactions:            # the read path that makes "exactly one" countable
    get:
      parameters: [ { name: idempotency_key, in: query, type: string } ]
      responses: { "200": { schema: { transactions: [transactionResponse] } } }
```
Why this is *minimal*: the header turns hearsay into a contract, and the list endpoint is the smallest read surface that can count per key. It also serves the ledger's reconciliation need (C3b §2), so it is not a test-only endpoint. `Idempotent-Replayed` is optional but is what the production metric in §5 keys on.

## 3. Root-cause hypotheses (ranked)

All three live in the same place: **the gap between "have I seen this key?" and "record that I've seen it"**.

| Rank | Mechanism | Why likely here | Discriminating observation |
|---|---|---|---|
| **H-A** | **Check-then-insert with no atomic reservation.** `SELECT key → miss → process → INSERT tx → store response`, with no `UNIQUE(idempotency_key)`. Concurrent requests all miss. | The most common v1 implementation. Hearsay "same key gets the original response" describes a response cache, not a reservation. | Duplicate rows share the key and their `created_at` values are **milliseconds apart**, inside one request's processing time. It reproduces with T1-01 at N≥2 on a **single instance**, and its rate scales with N. Schema: **no unique index** on the key. |
| **H-B** | **Key recorded only after commit, combined with client timeout < server latency.** Not concurrent at all: the first request is still in flight (unrecorded) when the client's timeout-retry arrives. | "Retry storm" means a client timing out and retrying. A slow DB makes requests in flight longer than the client timeout. | Duplicates are spaced by **≈ the client's retry interval** (hundreds of ms to seconds), and the first request's latency exceeds the client timeout. It reproduces **sequentially** (N=2 with a delay) once DB latency is injected, but **not** at the same rate with T1-01 on a fast DB. |
| **H-C** | **Per-instance idempotency store** (in-memory map or local cache) behind a load balancer: retries landing on another pod miss. | Common when idempotency is bolted on as middleware | Duplicate requests carry **different instance/pod ids** in logs. It **does not reproduce against a single instance** at any N, and reproduces readily through the load balancer. |

The fix for all three is the same (§6). That is why I'd fix the class rather than debug the instance first. The discriminators matter for the postmortem: they show whether other endpoints share the flaw. H-C, for example, would affect every endpoint using that middleware.

## 4. Regression guardrail

- **The test:** T1-01 + T1-02, exactly as in §1.
- **Gates:**
  - **PR**: N=25, against the fake (today) and an ephemeral service build (target state).
  - **Nightly**: staging, N=50 × 5 rounds.
  - **Pre-release**: staging, **N=200 × 20 rounds, retries=0**. That is 4,000 contended requests per release, for under a minute of runtime.
  - **Mutation gate on every PR:** the `idem-race` fault **must remain killed**. If someone weakens T1-01 (e.g. drops the count assertion), the mutation run goes red even though T1-01 is green.
- **How it is prevented from becoming a flaky test that is retried into green:**
  1. **Its oracle is a count, not a timing.** There is no sleep and no latency threshold. Under a correct server it cannot fail by chance.
  2. **No retry can turn it green.** CI's one retry only captures a trace, `failOnFlakyTests` turns a pass-on-retry into a red build, and pre-release runs @p0 with `--retries=0`.
  3. **Policy: one red T1 run is a P0 defect until disproven.** A race is probabilistic, so "intermittent" *is* the bug's signature. Triage uses the attached histogram; transport errors (ECONNRESET, timeouts) are reported separately from oracle failures (count = 2).
  4. **It cannot be skipped or quarantined by automation:** heal-guard blocks any diff that adds `test.skip`/`test.fail` or changes an assertion, and CODEOWNERS on `tests/incident/` requires the payments lead.
  5. **It can't go green by being blind:** on a target without the read path it **fails** with "NOT VERIFIABLE". It never skips.

## 5. Production metric and alert

| | Primary: direct | Secondary: leading |
|---|---|---|
| **Signal** | `txn_duplicate_idempotency_key_total`: rows sharing `(client_id, idempotency_key)` (until the API has authenticated clients, `account_id` stands in for `client_id`, as in the query below) | `idempotency_conflict_rate`: share of POST /transactions answered by replay or 409, per client id |
| **Source** | A SQL check every 60 s on the read replica: `SELECT count(*) FROM (SELECT 1 FROM transactions WHERE created_at > now() - interval '15 min' GROUP BY account_id, idempotency_key HAVING count(*) > 1) d` exported as a gauge. Plus a CDC/ledger reconciliation job that compares the transaction count per key with ledger postings. | API gateway / service metrics, labelled by client id, using the `Idempotent-Replayed` header (§2) |
| **Threshold** | **> 0 for one evaluation** (a duplicate is never acceptable) | > 5× the client's 7-day baseline for 5 minutes (a retry storm in progress) |
| **Who is paged** | **Payments on-call (PagerDuty, P1)**; auto-opens an incident; notifies Payments Ops with affected `account_id`s for proactive refunds | Ticket + Slack to payments on-call and the **client integration owner**. It is a warning that PISMO-4412 conditions are present, before any duplicate exists. |

For clients that don't send keys (if the header stays optional), add a heuristic: the same `(account_id, amount, operation_type_id)` within 2 s, more than 1 time, gives a daily report rather than a page, since false positives are possible.

## 6. Systemic fix: close the class, keep it closed

**Code (dev):**
- **Reserve, then process.** In one DB transaction: `INSERT INTO idempotency(client_id, key, request_hash, status='in_progress')` with **`UNIQUE(client_id, key)`**. On conflict: same hash and completed means return the stored response with `Idempotent-Replayed: true`; same hash and in progress means 409; different hash means 422. The transaction insert, the audit row and the stored response all commit **in the same DB transaction**.
- **A backstop constraint:** `UNIQUE(client_id, idempotency_key)` on `transactions` itself (the same scope as the reservation), so even a buggy code path cannot write two.
- The header is **required**; key TTL ≥ the client's maximum retry horizon (24 h); no in-memory idempotency stores.
- Apply the same pattern to `POST /accounts` (PD-6).

**Contract:** the v1.1 changes in §2. Add a lint rule (Spectral, in the provider's CI): *every POST under `/transactions` must declare a required `Idempotency-Key` header and a 409/422*.

**CI gates:** T1 in PR, nightly and pre-release (§4); the `idem-race` mutation must stay killed; a DB-integration test in the service repo with real Postgres and concurrent goroutines asserting the UNIQUE violation path; can-i-deploy for the ledger consumer, whose pact requires the header and the read path.

**Review process (so it outlives me):**
- **PR checklist for any money-mutating endpoint:** "Is the key reserved atomically? Is there a DB constraint backstop? Is there a concurrency test? Are audit and business writes in one transaction?"
- **CODEOWNERS** on `contract/`, `tests/incident/` and the idempotency package: payments lead plus QA.
- An **ADR** that makes "reserve-then-process" the squad standard.
- **Postmortem actions** each have an owner and a due date, tracked to closure. The guardrail belongs to the squad, not to me.
