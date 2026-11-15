# Design: a quality capability for the Transactions Service

The Transactions Service is about to become a system of record for money, and all I have is its OpenAPI contract and six things the engineer said in standup. So the job has two halves: decide what can and can't be trusted about the service today, and build a test capability that keeps answering that question as the service changes. This document maps each requirement to the solution I chose and the main trade-offs. The details are in [docs/](docs/).

## Constraints and assumptions

- **No code, no running service, no database.** Everything runs against a mock generated from the contract today, and is written to run unchanged against a real environment tomorrow.
- **A mock only proves the harness.** It answers with the contract's example values, so it can't show behaviour. Behaviour tests therefore skip on the mock instead of passing by coincidence, and a separate fault-injection fake proves that the tests can fail.
- **The contract and the verbal claims are both treated as claims to check, not facts.** Where they disagree, that's a finding.
- **Working assumptions until the dev or PO answers** (each one is labelled `assumption` in the tests that rely on it): amounts are rupees with at most 2 decimals; the idempotency header is `Idempotency-Key`; operation types 1–3 are debits and 4 is a credit; `type` is `debit` or `credit`; the request-ID header is `X-Request-Id`.

## Architecture

```
tests/<layer>/*.spec.ts        what engineers write: domain calls, oracle(), expect
        │
framework/fixtures.ts          API client, fresh account, namespaced test data, teardown manifest,
        │                      and an automatic contract check on every response
        ├── client/            createAccount, createTransaction, listTransactions, raw()
        ├── contract/          schema validator that reads the YAML
        └── config/            THE SEAM: TARGET = mock | fake | any environment in environments.json
                               (staging, uat, preprod), each with its own URL and capabilities
tools/                         fault-injection fake + mutation run, consumer verification, drift probe,
                               test generator + heal-guard, traceability matrix, JMeter runner + SLO gate
.github/workflows/             PR, nightly (per environment) and pre-release gates
```

## Requirements and proposed solutions

### C1. Strategy, risks and metrics
**Requirement:** rank what can go wrong, decide how to test it and who owns what, and choose numbers a release decision can rest on.

- **Risks** are ranked by the cost of one occurrence times how silently it fails. Double charges, wrong amounts or signs, misattributed money, a lost audit trail and unauthorised money movement are the P0s. Slowness matters mainly because timeouts trigger the retries behind PISMO-4412.
- **Test layers** are chosen by what each can prove with only a contract. Dev owns unit tests and database-level tests (unique constraints, audit row in the same transaction); QA owns the contract checks, behaviour tests, concurrency tests and the gates.
- **Metrics** are the ones that change a decision: P0 risk status (green *and* verifiable), mutation score on P0 faults, flake rate, contract drift and production money-integrity signals. Pass rate, test count and coverage are treated as vanity, with reasons.
- **18 open questions** for the dev and PO, 10 of them blocking sign-off.

Where: [docs/C1-test-strategy.md](docs/C1-test-strategy.md)

### C2. Framework and CI
**Requirement:** a framework other engineers can extend, a cheap swap from mock to staging, sensible CI gates, and a strategy for flaky tests and shared state.

- **The seam:** tests ask the target what it can do (does it keep state? can it list transactions? which contract does it honour?) rather than "am I on the mock?". Moving to a real environment is `TARGET=staging` plus its URL; adding an environment is one JSON entry.
- **Fixtures** give every test an API client that checks every response against the contract automatically, a fresh account, test data namespaced by run, shard and worker, and a teardown manifest (the API has no DELETE).
- **CI:** the PR gate touches no shared environment (static checks, the suite against the mock and the fake, the mutation run). Nightly runs per environment. Pre-release runs the P0 tests with zero retries plus the performance SLOs. A retry can capture a trace but never turn a test green.
- **Parallel safety** comes from data partitioning, not separate environments: every test owns its accounts, and nothing asserts global state.

Where: [docs/C2-framework-and-ci.md](docs/C2-framework-and-ci.md), [framework/](framework/), [CI workflow](.github/workflows/quality-gates.yml)

### C3a. Contract audit
**Requirement:** a findings register with a classification of my own, anchored to the contract.

- Findings are classified by **what they stop us doing**, because that decides the fix and the owner: UNSAFE (money can go wrong), UNVERIFIABLE (a promise we can't check), AMBIGUOUS, INCONSISTENT, INCOMPLETE and HYGIENE, plus a severity. Every finding cites YAML lines; several are checked automatically by unit tests.
- The six verbal claims are checked one by one: one is in the contract's text but contradicted by its own schema (the sign rule), and five aren't in the contract at all.

Where: [docs/C3a-contract-audit.md](docs/C3a-contract-audit.md)

### C3b. Validation layer, consumer contracts, mock drift
**Requirement:** schema-driven validation, contracts for the mobile app and the ledger, and a way to keep the mock honest.

- **Validator:** reads the YAML directly (no hand-written schemas) and checks the status, media type and body of every response. It has its own tests.
- **Consumer contracts:** the mobile app is a tolerant reader; the ledger needs every field, closed value lists and a way to reconcile. Both are checked against any contract version: today's fails all 7 interactions, my proposed version passes.
- **Drift:** a register of the places Prism doesn't follow its own spec, and a nightly probe per environment that alerts only on *new* drift.

Where: [docs/C3b-validation-consumers-drift.md](docs/C3b-validation-consumers-drift.md), [validator](framework/contract/validator.ts), [consumers/](consumers/)

### C4. Test suite and traceability
**Requirement:** a deterministic suite covering accounts, transactions, amounts, referential integrity, idempotency and cross-cutting cases, where every case states its oracle, plus a traceability matrix.

- Every case declares **what it asserts, on whose authority** (contract, hearsay, domain reasoning or my assumption) and **which risks it retires**.
- The amount cases state both what *should* happen and what the contract actually promises.
- The traceability matrix is **generated from the code** and fails the build if a case retires no risk; the hand-written view adds the specific defect each case catches.
- **Proof the tests have teeth:** 12 realistic bugs planted one at a time in the fault-injection fake are all caught, with no false alarms.

Where: [docs/C4-test-design.md](docs/C4-test-design.md), [tests/](tests/)

### C5. Defects and predictions
**Requirement:** contract defects in report form, and falsifiable predictions of what's broken in the implementation.

- Contract defects carry title, severity, evidence, expected vs actual and business impact.
- **13 predictions**, ranked by money impact, each with the exact test that settles it and the observation needed. 10 of them are simulated in the fake, so the test is known to catch them.

Where: [docs/C5-defect-registers.md](docs/C5-defect-registers.md)

### T1. Incident PISMO-4412
**Requirement:** prove or disprove the double debit, work out whether "exactly one" is even observable, explain the likely cause, and stop it coming back.

- **Test:** N requests with the same idempotency key, released together, verified by **counting** the transactions written, with a control run using distinct keys.
- **Key finding:** the published API has no way to count transactions, so on a real service the test fails as "not verifiable", and sign-off is blocked until a required `Idempotency-Key` and a list endpoint exist. That minimal change is written up as a proposed contract.
- **Root cause:** three ranked hypotheses, each with the observation that tells it apart from the others.
- **Guardrail and fix:** the test runs in every gate and is never retried into green; a production alert fires on any duplicate key; the systemic fix is "reserve the key, then process" with a unique constraint, plus a contract lint rule, CI gates and a review checklist.

Where: [docs/T1-incident-PISMO-4412.md](docs/T1-incident-PISMO-4412.md), [the test](tests/incident/pismo-4412.spec.ts), [proposed contract](contract/proposed/)

### T2. Performance testing
**Requirement:** a justified tool, SLOs declared up front, a runnable script with concurrency on the idempotency path, honesty about mock numbers, and a regression gate that ignores infrastructure noise.

- **JMeter**, because performance engineers already know it and it offers fixed-rate (open-model) load without plugins. A Synchronizing Timer drives the same-key storm.
- **SLOs** (50 transactions/s, p95 ≤ 300 ms, p99 ≤ 800 ms, ≤ 0.1% errors, zero duplicate transactions under the storm) are declared in a data file, each with where the number comes from.
- The runner **refuses to run against the mock**. A gate enforces the SLOs, and a regression gate compares against the median of recent runs and only fails on a confirmed, meaningful slowdown.
- CI runs it per environment after the other nightly jobs, and as a blocking step in pre-release.

Where: [docs/T2-performance.md](docs/T2-performance.md), [perf/](perf/)

### T3. End-to-end journey
**Requirement:** a Playwright journey from opening an account to checking the resulting state.

- One cardholder: open an account, post one transaction of each operation type, read the account back.
- Split into a wiring test that runs on the mock and a money-state test that needs a real store, so the mock can't pass the money checks by example.

Where: [tests/e2e/cardholder-journey.spec.ts](tests/e2e/cardholder-journey.spec.ts)

### T4. AI-assisted test generation and guardrails
**Requirement:** use AI to generate and maintain tests at scale, without letting it heal a test into green when the app is broken.

- Tests that follow directly from the contract are generated **deterministically**: no AI where the contract is the answer key.
- **Heal-guard** blocks any automated change to an assertion, a skip or a source of truth (contract, validator, SLOs).
- The mutation run measures the false-pass and false-fail rates, so automation has to prove it's net positive.
- AI is kept away from money rules, auto-healing P0 tests, editing contracts, setting thresholds and release decisions.

Where: [docs/T4-ai-test-generation.md](docs/T4-ai-test-generation.md), [tools/ai-gen/](tools/ai-gen/)

## Key decisions and trade-offs

| Decision | Why | Cost I accepted |
|---|---|---|
| Behaviour tests skip on the mock | A pass there would only be the contract's example value | 63 tests show as skipped on the mock |
| The T1 test fails "not verifiable" instead of skipping | A guardrail that can't see must not look green | The suite is red on a real environment until the read path exists |
| A fault-injection fake | The only way to show the tests can fail without the real service | It encodes my assumptions, so it's labelled as such everywhere |
| A proposed contract (v1.1) | Turns the findings into a concrete, reviewable ask | It's my proposal, not the provider's |
| Exact tool versions | Prism's behaviour is part of what the tests depend on | One unreachable advisory remains in Prism's dependencies (documented) |
| Environments as data | Adding UAT or pre-prod shouldn't need code changes | A JSON file to keep under review |

## What would change this design

- **Answers to the blocking questions** (amount unit and rounding, idempotency rules, a read path, authentication) would turn assumption-based tests into contract-based ones.
- **Access to the service code** would add an ephemeral environment per pull request and database-level tests for the audit trail and unique constraints.
- **A production-like environment** would give the performance plan its first real baseline, and the SLOs could then come from real traffic.
