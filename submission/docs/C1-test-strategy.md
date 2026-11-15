# C1: Test strategy, risk and metrics

**Service:** Transactions Service v1.0 (accounts and money movements) · **Inputs:** the published contract, six hearsay claims · **No** code, running instance or DB.

**Position in one line:** the service cannot be signed off for real money today. That is not because tests fail. It is because the three properties that matter most (exactly-once, correct sign and amount, an intact audit trail) are **not specified or not observable** through the published contract. The strategy below is built to make them testable, then keep them tested.

---

## 1. Risk model

Ranked by **business cost of one occurrence × how silently it fails**. A loud failure (a 500) is cheaper than a quiet one (a wrong number that reconciles nowhere).

| Id | Failure mode | Cost when it happens | Why it is silent / likely here | Priority |
|---|---|---|---|---|
| **R1** | **Double charge**: one customer intent, two debits (retries, concurrency) | Direct customer loss, refunds, chargebacks, regulator complaint; already happened (PISMO-4412) | Every reply looks normal. Contract has no idempotency header and no way to count (CF-01). | **P0** |
| **R2** | **Wrong money**: wrong sign, rounding/truncation, unit confusion, negative→credit flip | A balance that is wrong *and believed*; compounding reconciliation breaks | `amount` is a bare float (CF-02/05); the sign rule is prose (CF-19); unit is hearsay (H1) | **P0** |
| **R3** | **Misattributed money**: posted to a non-existent or wrong account, or an unclassifiable op type | Money that belongs to nobody or the wrong person | Op type has no enum (CF-07); unknown-op handling undefined | **P0** |
| **R4** | **Lost or divergent audit trail** | Cannot prove what happened. A compliance failure, and it makes every other incident unresolvable | H6 is hearsay, unobservable by API (CF-21) | **P0** |
| **R5** | **Unauthorised money movement** | Fraud: anyone who can reach the host can post a credit voucher | Contract has no `securityDefinitions` at all (CF-16) | **P0** |
| R6 | Consumer break: a contract change breaks the ledger or mobile app | Ledger stops booking (back-office outage); app crashes | No `required`, no enums: the provider can "conform" while dropping fields (CF-03/08) | P1 |
| R7 | Identity integrity: duplicate or invalid document numbers | KYC and fraud exposure; split balances per person | Validation and uniqueness are hearsay (H4, CF-06/10) | P1 |
| R8 | Robustness: malformed or oversized input gives 5xx, hangs or partial writes | Availability; a partial write becomes R2/R4 | Error semantics undefined (CF-14/15) | P2 |
| R9 | Untraceable failures (no request correlation) | Slower MTTR on R1–R4 | H5 hearsay, not in contract (CF-12) | P2 |
| R10 | Latency / throughput | Timeouts, which **drive client retries, which drive R1** | No SLO exists | P3 *(alone)*; treated as an R1 amplifier |

**Why these are the P0s, and why the costs differ.** A **slow endpoint** costs minutes and is visible to everyone. Its main danger is indirect: timeouts trigger retries, which is exactly how PISMO-4412 happened. A **double charge** is a customer-visible loss with a clear victim. It is recoverable but erodes trust, and it is already recurring here. A **wrong balance** is worse: it is believed. Downstream systems book it, statements show it, and the error compounds until reconciliation finds it, if reconciliation exists. A **lost audit trail** is worst of all, because it removes the ability to detect or prove any of the others. It turns every future incident into an argument. So the ranking puts *silent and compounding* above *loud and bounded*.

## 2. Test approach and pyramid

The pyramid is shaped by one constraint: **I have a contract, not a service.** So each layer is chosen for what it can *actually prove*, and where it runs (mock / fault-fake / staging) is part of the design.

| Layer | Owner | What it earns its keep on | What it can't do | Runs |
|---|---|---|---|---|
| **Unit** (in service repo) | **Dev** | Sign mapping, rupee→paise conversion, rounding rule, validation functions, op-type lookup. Cheapest place to kill R2. Property-based tests on money arithmetic. | Concurrency, DB constraints, wiring | Dev PR |
| **Integration with a real DB** (service repo) | **Dev**, QA reviews | Idempotency reservation + **UNIQUE constraints** under real concurrency; audit row in the same DB transaction (R1, R4, R7) | Cross-service behaviour | Dev PR |
| **Contract** (validator, consumer pacts, drift) | **QA** owns the tooling, **dev** owns keeping it green | Shape and status conformance on every response, automatically (R6); consumer can-i-deploy; drift between contract, mock and staging | Semantics: a contract this loose permits most money bugs | Every gate |
| **Functional / API** (this repo) | **QA** | Behavioural oracles per risk: sign, amounts, idempotency, referential integrity, errors (R1–R3, R7–R9) | Anything the API cannot observe (R4) | Fake (PR), staging (nightly) |
| **Concurrency / incident** (T1) | **QA** | Exactly-once by count under a storm (R1) | Proof without a read path (see T1 §2) | PR, nightly, pre-release |
| **E2E journey** (T3) | QA | One cardholder across all operations: wiring, and net movement on stateful targets | Breadth. Kept to 2 tests on purpose. | PR, nightly |
| **Perf** (T2) | QA + SRE | JMeter plan: open-model load on `POST /transactions` and `POST /accounts`, plus a same-key storm on the idempotency path (R10, and R1 under load). SLOs as a gate (docs/T2) | Anything on a mock: the runner refuses it | Nightly per environment, pre-release (blocking) |

**Deliberately not tested (and why):**
- **Service correctness against the Prism mock.** A mock built from the spec conforms by construction. Behavioural tests are *skipped* on it, never "passed by example" (see SUBMISSION §2).
- **The audit trail through the API.** Not observable. I require evidence instead (OQ-12): a DB-level test in the service repo, plus an audit read path or a query runbook.
- **Authentication/authorisation.** There is none to test (CF-16). That is a release blocker for security review, not a test gap I can close.
- **Exhaustive document-number formats.** Boundaries (9/10/14/15) and character classes only. The rule itself is unconfirmed (OQ-4), so depth there is waste until it is answered.
- **Load numbers against the mock or the fake.** They would measure this laptop, so `npm run perf` refuses the mock. Real numbers need a production-like environment (docs/T2 §7).

**QA vs dev boundary.** Dev owns *correctness of the code* (units, DB integration, the idempotency mechanism itself). QA owns *the evidence that the system is safe to release*: the risk model, the contract as a testable artefact, cross-cutting suites, gates, and the metrics a release decision rests on. Shared: the contract (dev writes, QA can block), and the incident guardrails (QA writes, both maintain via CODEOWNERS).

**Pushed left into dev:** UNIQUE constraints and migration tests for `(client, idempotency_key)` and `document_number`; integer minor units (or decimal) as the money type, with property tests; contract lint in the dev PR (every money-moving POST must declare a required `Idempotency-Key`; every schema must declare `required`); provider-side pact verification in the dev PR; spec generated from code is fine, but **contract diffs need QA approval** (CODEOWNERS).

## 3. Quality metrics

**Vanity, and why:**
- **Pass rate.** 99.5% green with the 0.5% being the double-charge test is a failed release. Pass rate also rewards retries.
- **Test count.** It rewards trivial tests. My generator alone adds 19 tests in one second.
- **Coverage %.** "Code executed" is not "behaviour asserted". My mock run hits 100% of endpoints and proves nothing about the service.

**What replaces them** (each one changes a decision if it moves):

| Metric | Replaces | Definition | Release rule |
|---|---|---|---|
| **P0 risk status** | pass rate | Per P0 risk: are its guarding tests *green on the release candidate*, and are they *verifiable* on that target (not skipped, not "not observable")? | Any P0 red **or unverifiable** = no-go |
| **Mutation score on P0 faults** | coverage % | Seeded P0 defects caught / seeded (today 8/8 P0, 12/12 total, `npm run test:mutation`) | < 100% on P0 = no-go |
| **Flake rate and quarantine age** | pass rate | Tests that changed verdict on the same SHA (nightly `--repeat-each`); quarantined count and oldest age | P0 tests can't be quarantined; quarantine older than 7 days alerts the owner |
| **Contract drift** | — | New drift findings vs baseline (nightly probe); consumer can-i-deploy status | New drift on a money field, or can-i-deploy red = no-go |
| **Money-integrity signals (prod)** | escaped-defect anecdotes | Duplicate `(account, idempotency_key)` rows; ledger reconciliation breaks (count and ₹); sign anomalies (op 1–3 with positive amount); 5xx on POST /transactions | Any duplicate or recon break opens an incident |
| **Escaped defects by risk** | test count | Prod defects mapped to R1–R10, with the gate that should have caught them | Trend; feeds the gate design |

**Dashboard sketch (release manager view).** The layout is the proposal. The staging and production numbers are *illustrative*: no staging run exists yet. The mutation and can-i-deploy figures are real outputs of this repo.

```
┌ Transactions Service · RC 1.4.0 · staging · 2026-11-13 02:10 ─────────────────────────────┐
│ VERDICT: NO-GO   (R1 unverifiable · R5 no auth · 10 blocking questions open)                │
├──────────────── P0 RISKS ─────────────────────────┬──── TEST HEALTH ────────────────────────┤
│ R1 double charge   ■ UNVERIFIABLE (no read path)  │ Mutation (P0)   8/8  ████████████ 100%   │
│ R2 wrong money     ■ 24/24 green  ◆ verifiable    │ Flake rate 7d   0.4%  (2 tests, non-P0)   │
│ R3 misattributed   ■ 7/7 green    ◆ verifiable    │ Quarantine      1  (oldest 2d, owner: AK) │
│ R4 audit trail     ■ NO EVIDENCE (OQ-12 open)     │ Retries used    0 on P0 (policy: 0)       │
│ R5 unauthorised    ■ NOT ADDRESSED (CF-16)        │                                          │
├──────────────── CONTRACT ─────────────────────────┼──── PRODUCTION (last 7d) ───────────────┤
│ Drift vs v1: 0 new · 9 known                      │ Dup idempotency rows       0             │
│ can-i-deploy: mobile ✗ 4 · ledger ✗ 3 (v1)        │ Recon breaks               0  (₹0)       │
│               mobile ✓   · ledger ✓   (v1.1-prop) │ Sign anomalies             0             │
│ Blocking questions: 10 open / 18                  │ POST /transactions 5xx     0.02%         │
└───────────────────────────────────────────────────┴──────────────────────────────────────────┘
```

## 4. Assumptions and open questions

Assumptions I work under (each is labelled `assumption` in test oracles, and each can be overturned by one answer):
A1 amounts are INR major units with at most 2 decimals; A2 the idempotency header is `Idempotency-Key`; A3 ops 1–3 are debits and op 4 a credit; A4 `type` ∈ {debit, credit}; A5 the request-ID header is `X-Request-Id`; A6 an account is the natural isolation unit for test data in shared staging.

| # | Question for dev / PO | Blocking? | Why it matters |
|---|---|---|---|
| OQ-1 | What unit is `amount` in, how many decimals, and what is the rounding rule (or is excess precision rejected)? | **Blocking** | R2: without it, no amount test has an authoritative oracle |
| OQ-2 | Are zero and negative amounts rejected (which status)? | **Blocking** | R2: the "negative purchase becomes credit" class |
| OQ-3 | Maximum amount per transaction? | **Blocking** | R2 overflow / fat-finger |
| OQ-6 | Idempotency: header name, required?, scope, TTL, behaviour on body mismatch and while in flight, replay status | **Blocking** | R1: PISMO-4412 |
| OQ-11 | Will you add a read path so "exactly one" can be counted (T1 §2)? | **Blocking** | R1 is unverifiable without it |
| OQ-12 | Evidence the audit row is in the same DB transaction; how can ops read audit? | **Blocking** | R4 |
| OQ-13 | Who may call POST /transactions? AuthN/Z model? | **Blocking** | R5 |
| OQ-14 | Op 2 (installments): is `amount` the total or one installment? Where is the count? | **Blocking** | R2 for every installment purchase |
| OQ-15 | Single currency (INR) only? Behaviour for an unknown `currency` field? | **Blocking** (pairs with OQ-1) | R2 unit confusion |
| OQ-7 | Enumerate `type` values | **Blocking** for ledger consumer | R6 |
| OQ-4 | Exact document-number rule (length, digits only, checksum, doc types) | Non-blocking (money); KYC follow-up | R7 |
| OQ-5 | Duplicate document: rejected? 409 or 400? Multiple accounts per person allowed? | Non-blocking | R7 |
| OQ-8 | Non-existent account on POST /transactions: 422 or 404? | Non-blocking | Client error handling |
| OQ-9 | Request-ID header name; echo client value? | Non-blocking | R9 |
| OQ-10 | Body size limit? | Non-blocking | R8 |
| OQ-16 | Overdraft/balance rules for withdrawals? (no balance in contract) | Non-blocking for v1; product gap | Future R2 |
| OQ-17 | A test tenant or cleanup policy on shared staging? | Non-blocking | Test-data hygiene |
| OQ-18 | Is the spec generated from code (the `handler.` prefixes suggest swaggo)? Who approves contract diffs? | Non-blocking | R6 governance |
