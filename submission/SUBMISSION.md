# SUBMISSION: Transactions Service QA Case Study

**Candidate:** Srishti Syal

**Total time spent:** about 6 h 15 min, AI-assisted (see [AI_NOTES.md](AI_NOTES.md)): roughly 1 h planning, 2 h 10 min building, and 3 h 5 min reviewing, hardening and packaging.

**Stack chosen:** TypeScript with Playwright Test (API client, no browser), Prism and Ajv, plus JMeter for load. Why: the brief already requires Playwright, so running the API suite on it too gives the squad one runner and one report; Prism and Ajv work straight from the OpenAPI contract, so the mock and the checks come from the spec itself rather than hand-written copies; JMeter is the load tool most performance engineers already know.

---

## 0. Read this first

I treated this as a "can we ship this?" question with nothing but a contract to go on. I built a test framework that runs against a mock today and against staging, UAT or any other environment by changing one setting, and I made sure it actually goes red when the service is broken: I planted 12 realistic bugs in a fake service and the tests catch every one. My main finding is that the contract makes almost none of the promises a money-movement service needs. No field is required, amounts are unbounded decimals with no currency, there's no authentication, and worst of all there's no way to see what was written, so "a retry never charges twice" can't be checked at all. The one thing I'd fix before real money: make idempotency part of the contract and make it countable, with a required `Idempotency-Key` header and a way to list an account's transactions. Until that exists, I can't sign off PISMO-4412.

## 1. Index

| # | Deliverable | Where | How to run | Time spent |
|---|---|---|---|---|
| C1 | Test strategy, risks and metrics | [docs/C1-test-strategy.md](docs/C1-test-strategy.md) | A document | ~20 min |
| C2 | Framework and CI design | [docs/C2-framework-and-ci.md](docs/C2-framework-and-ci.md), [framework/](framework/), [CI workflow](.github/workflows/quality-gates.yml) | `npm test` | ~70 min |
| C3a | Contract audit | [docs/C3a-contract-audit.md](docs/C3a-contract-audit.md) | A document; several findings are checked by `npm run test:unit` | ~25 min |
| C3b | Schema validation, consumer contracts, mock drift | [docs/C3b-validation-consumers-drift.md](docs/C3b-validation-consumers-drift.md), [validator](framework/contract/validator.ts), [consumers/](consumers/) | `npm run consumers:verify` | ~20 min |
| C4 | Test design, the suite, traceability matrix | [docs/C4-test-design.md](docs/C4-test-design.md), [tests/](tests/), [matrix](docs/C4-traceability-matrix.generated.md) | `npm test`, then `npm run test:fake` | ~35 min |
| C5 | Contract defects and predicted implementation bugs | [docs/C5-defect-registers.md](docs/C5-defect-registers.md) | A document; `npm run test:mutation` shows each of the 10 predictions that can be simulated over HTTP gets caught | ~10 min |
| T1 | PISMO-4412 incident write-up and guardrail test | [docs/T1-incident-PISMO-4412.md](docs/T1-incident-PISMO-4412.md), [the test](tests/incident/pismo-4412.spec.ts) | `npm run test:incident` | ~20 min |
| T2 | Performance testing with JMeter | [docs/T2-performance.md](docs/T2-performance.md), [perf/](perf/) | `TARGET=staging STAGING_URL=… npm run perf` (needs JMeter; it won't run against the mock). To see it run locally: `npm run fake`, then `TARGET=fake npm run perf -- --harness-check` | ~35 min |
| T3 | Playwright end-to-end journey | [tests/e2e/cardholder-journey.spec.ts](tests/e2e/cardholder-journey.spec.ts) | `npm run test:e2e` | ~5 min |
| T4 | AI-assisted test generation and guardrails | [docs/T4-ai-test-generation.md](docs/T4-ai-test-generation.md), [tools/ai-gen/](tools/ai-gen/) | `npm run generate:tests`, `npm run heal-guard -- tools/ai-gen/examples/*.diff` | ~15 min |
| — | AI notes | [AI_NOTES.md](AI_NOTES.md) | — | ~10 min |

Times per deliverable are approximate and don't include the planning hour or the ~50 minutes spent writing this summary and the design notes and packaging the submission.

**To run it** (a clean machine, about 10 minutes). You need Node 24.18 or newer, nothing else: no browser and no Docker. JMeter 5.6.3 (with Java 17+) is only needed for the performance plan.

```bash
cd submission
npm ci                      # installs the exact versions I tested with
npm test                    # starts the mocks itself, ~10 s. Expect 56 passed, 63 skipped, 0 failed
npm run test:fake           # the same suite against my fault-injection fake. Expect 119 passed
npm run test:mutation       # plants the 12 bugs one at a time, ~1 min. Expect all 12 caught
npm run consumers:verify    # fails on purpose: today's contract can't satisfy either consumer
npm run report              # opens the HTML test report
```

Why 63 skipped on the mock but all 119 passing on the fake? It's the same 119 tests. 63 of them check behaviour (signs, amounts, idempotency, duplicates), and the mock only replays example responses from the contract, so on the mock they skip on purpose rather than pass by coincidence. The fake keeps state and behaves the way I assume a correct service would, so there all 119 run. Section 2 has more. A few extra commands, if you want them:

```bash
# my proposed contract satisfies both consumers (this one passes)
npm run consumers:verify -- --contract contract/proposed/transactions-service.v1.1-proposed.yaml

# rebuild the traceability matrix (after test:fake and test:mutation)
npm run matrix

# drift check: start the mock, then run this in another terminal
npm run mock
npm run drift:check -- --target http://127.0.0.1:4010

# any environment listed in framework/config/environments.json
TARGET=uat UAT_URL=https://… npm test

# watch the PISMO-4412 test catch the race
TARGET=fake FAULTS=idem-race npx playwright test --project=incident
```

The tests use ports 4010–4011 (Prism) and 4020–4042 (the fake). The exact tool versions, and the vulnerable dependencies I found and replaced, are in the appendix at the end.

## 2. What my green build does and does not prove

| What runs | What a green result tells you | Still valid against real staging? |
|---|---|---|
| Contract checks against the mock | The harness, the API client and the schema validator work, and Prism follows its own spec (except in 3 places I found and recorded). Nothing about the real service. | Yes. Pointed at staging, the same checks test the service itself. |
| Behaviour tests: signs, amounts, idempotency, duplicates, request IDs | Nothing yet. They're skipped on the mock on purpose: a pass there would just be the spec's example value lining up with my expectation. | Yes. That's what they were written for. |
| The same suite against my fault-injection fake | That the tests can fail. All 12 planted bugs were caught, with no false alarms. The fake encodes my assumptions, not the real service. | No. |
| The PISMO-4412 concurrency test | The test is wired correctly. Against today's real API it fails with "not verifiable", and that's the honest answer. | Yes. It goes green once the service can list transactions. |
| The JMeter performance plan | The plan runs end to end, and its same-key storm catches the double-debit bug in my fake (5 transactions for one key). No performance numbers: measuring the mock would only measure my laptop, so the runner refuses to. | Yes. CI runs it against staging and UAT. |
| Validator self-tests | That the schema validator itself catches bad responses, and that today's contract really does accept things it shouldn't (an empty object `{}`, a negative amount). | Not network-dependent; always meaningful. |

**What none of this proves:** that the service is correct, that any money behaviour works, or that PISMO-4412 is fixed. Nothing here has touched the real service yet.

## 3. What I deliberately did not do, and why

| What I skipped | Why | With another day |
|---|---|---|
| Performance numbers | There's no real environment to measure, and numbers from the mock would only measure my laptop. Everything else for T2 is built and wired into CI. | Run the nightly performance job on staging and UAT for a week to get a baseline, then replace my invented targets with real production peaks |
| A real Pact broker | I wanted the consumer contracts to run offline for you | Move the pact files into the consumer repos, publish them to a broker, and check can-i-deploy in the provider's pull requests |
| The AI test-proposal pipeline from T4 | Designed only. The parts that stop AI from weakening tests are built. | Prototype it and measure how often its suggestions are right |
| A lint rule that every money endpoint needs an idempotency key | Specified in T1, not coded | Add the rule to the provider's repo |
| Testing a fresh build of the service on every PR | I don't have the service code | Add a docker-compose setup to the service repo and point this suite at it |
| Audit-trail tests | The audit trail isn't visible through the API | A database-level test in the service repo, plus a way to read audit records |
| Authentication tests | There's no authentication in the contract to test | It needs a security review either way |
| Every possible document-number format | The rule isn't confirmed yet | Add them once it's answered |

## 4. Top findings, ranked

I group findings by what each one stops us from doing, because that decides who fixes it and whether it blocks a release (full scheme in C3a). **UNSAFE** means money can go wrong. **UNVERIFIABLE** means a promise we can't check. **AMBIGUOUS** means two valid readings. **INCONSISTENT** means the contract contradicts itself. Rows 8 and 10 roll up several findings, so they are marked **Summary**. S1 means it blocks real money.

| # | Finding | Class | Severity | Why it matters |
|---|---|---|---|---|
| 1 | The contract has no idempotency header and no way to list transactions, so "exactly one transaction per retry" can't be checked (CF-01) | UNVERIFIABLE | S1 | We can't prove PISMO-4412 is fixed. Double debits would ship blind. |
| 2 | No authentication or authorisation at all (CF-16) | UNSAFE | S1 | Anyone who can reach the service can post a credit |
| 3 | No field is required, so an empty `{}` is a valid request and a valid response (CF-03) | UNSAFE | S1 | A response missing its amount still "passes the contract", and the ledger books incomplete rows |
| 4 | The text says "send a positive amount", but the schema accepts negatives (CF-02) | UNSAFE, INCONSISTENT | S1 | A −50 purchase could turn into a +50 credit |
| 5 | Amounts are unbounded decimals with no unit or currency (CF-05, CF-18) | UNSAFE, AMBIGUOUS | S1 | Rounding errors (0.29 becoming 0.28), overflow, and consumers disagreeing on rupees vs paise |
| 6 | Operation type can be any number, and which types are debits is only described in prose (CF-07, CF-19) | UNSAFE, AMBIGUOUS | S1 | An unknown type could be booked with a default sign, or as ₹0 |
| 7 | The promise that every write also writes an audit row can't be observed at all (CF-21) | UNVERIFIABLE | S1 | We can't sign off the audit trail, so investigations rely on trust |
| 8 | Five of the six things the engineer told us aren't in the contract at all. The sixth (the server sets the sign) is in its text, but the contract's own schema contradicts it by accepting negative amounts (C3a §3) | Summary | S1 | The service's safety story is verbal |
| 9 | `type` is free text, and for instalment purchases it's unclear whether the amount is the total or one instalment (CF-08, CF-27) | AMBIGUOUS | S2 | Misclassified ledger entries, and instalment amounts off by a factor |
| 10 | Today's contract fails both consumers' contracts on all 7 interactions (C3b §2) | Summary | S2 | The mobile app and the ledger can't safely rely on v1 |

## 5. What I'd require fixed before this service is trusted with real money

1. **Idempotency that's real and checkable.** A required `Idempotency-Key` header, clear answers for a request still in flight (409) and a reused key with a different body (422), and an endpoint to list an account's transactions. Built as "reserve the key first, then process", backed by a unique constraint in the same database transaction as the write and the audit row. I'd want the PISMO-4412 test green on staging at 200 concurrent requests, 20 rounds in a row.
2. **Authentication and authorisation** on every operation, with a security review.
3. **Money defined properly:** unit and currency, positive amounts only, a maximum, at most two decimals (or whole paise), a fixed list of operation types, and the direction each one moves money. The amount, sign and unknown-type tests green on staging.
4. **Required fields and fixed value lists** in the contract, with both consumer contracts passing.
5. **Evidence for the audit trail:** a database-level test showing the audit row commits together with the transaction, and a way for ops to read it.
6. **The quality gates switched on against the real service,** including the planted-bug check and the rule that a test never gets retried into green, plus the duplicate-key alert from T1 live before go-live.

## 6. Open questions for the dev / PO

These are the ones that matter most; the full list of 18 is in C1 §4.

| Question | Blocking? | Why it matters |
|---|---|---|
| What unit is the amount in, how many decimals, how is it rounded, and which currency? | **Blocking** | Without it, no amount test has a real answer key |
| Are zero and negative amounts rejected, and with which status? | **Blocking** | Decides whether a negative purchase can become a credit |
| What's the maximum amount? | **Blocking** | Overflow and fat-finger mistakes |
| How exactly does idempotency work: header name, required or not, scope, expiry, and what happens with a different body or a request still in flight? | **Blocking** | This is PISMO-4412 |
| Will you add a way to list transactions, so "exactly one" can be counted? | **Blocking** | Without it, double charges can't be verified |
| Can you show the audit row is written in the same transaction, and how can ops read it? | **Blocking** | Signing off the audit trail |
| Who is allowed to call the API? | **Blocking** | Today, anyone who can reach it can move money |
| For instalment purchases, is the amount the total or one instalment, and where's the instalment count? | **Blocking** | Affects every instalment purchase |
| What values can `type` take? | **Blocking** for the ledger | The ledger classifies entries by it |
| What's the document-number rule, are duplicates allowed, and is a duplicate a 409 or a 400? | Non-blocking | Identity checks, as a follow-up |
| For a missing account, 422 or 404? What's the request-ID header called? Is there a body size limit? | Non-blocking | Error handling and tracing |

---

## Appendix: tool versions and the dependency fix

Prism (5.16.0) and Playwright (1.65.1) are pinned to exact versions, so `npm ci` installs exactly what I tested with. Please use the Prism that `npm ci` installs rather than a global one: I recorded three places where Prism doesn't follow its own spec, and those tests depend on this version. JMeter 5.6.3 isn't an npm package; CI downloads the official build and checks its SHA-512 checksum.

I started on Prism 5.12.0 and Playwright 1.52.0. When I checked the dependencies and re-ran the setup on a clean machine, `npm audit` reported 14 known vulnerabilities, 10 of them high. I upgraded, pinned the versions, re-ran everything, and got identical results:

| Package (before) | Problem | Fixed in |
|---|---|---|
| faker ≤ 10.4.0, inside Prism | Code execution through `helpers.fake` | 10.6.0 (Prism 5.16.0) |
| playwright < 1.55.1 | Downloads browsers without checking the TLS certificate | 1.65.1 |
| js-yaml ≤ 4.3.1 | Prototype pollution, slow merge keys | 4.3.2 |
| lodash ≤ 4.17.23 | Code injection, prototype pollution | 4.18.1 |
| ajv, esbuild (via tsx), uuid | Moderate: a slow regex, a dev-server exposure, a bounds check | 8.20.0; 0.28.2 (tsx 4.23.15); 11.1.1 |

Six warnings remain, and they're all one advisory (GHSA-qxc2-j82w-r537). Every recent Prism release bundles a Postman-import library that pins an old faker. This project never runs that code: it mocks an OpenAPI file, and the vulnerable function is never called. I tried forcing a newer faker, and Prism crashed on startup, so I documented the warning instead of hiding it. I also tried npm's own suggested fix, which was to downgrade Prism to 5.6.0; that version has 10 vulnerabilities, 3 of them critical.
