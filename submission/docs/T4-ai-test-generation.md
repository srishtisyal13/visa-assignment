# T4: AI-assisted test generation and guardrails

**Principle:** AI is good at *enumerating* and *transcribing*. It is dangerous at *deciding what correct means* for an under-specified contract, because it will invent plausible behaviour with confidence. So the pipeline gives AI the enumeration and transcription work, and keeps every **oracle** under human or contract authority, enforced mechanically.

## 1. What is built and runnable

| Piece | What it does | Run |
|---|---|---|
| `tools/ai-gen/generate-from-contract.ts` | Generates 19 negative contract cases (wrong JSON types × every typed field, required body absent, bad path params) **deterministically** from the YAML. Each case has an `authority: contract` oracle anchored to the schema pointer. | `npm run generate:tests` · CI: `-- --check` fails if stale vs the contract |
| `tools/ai-gen/heal-guard.ts` | **The guardrail.** Rejects any diff that changes an oracle or a source of truth. | `npm run heal-guard -- tools/ai-gen/examples/*.diff` |
| `tools/mutation/run.ts` + `tools/fault-fake` | Measures false passes (survived faults) and false fails (baseline failures) | `npm run test:mutation` |

Heal-guard demo output (real run, abridged):
```
BLOCK  heal-bad-assertion.diff   changes an oracle: tests/functional/idempotency.spec.ts  -…toBe(422)  +…toBe(201)
BLOCK  heal-bad-contract.diff    protected file: contract/transactions-service.v1.yaml   +"500":
BLOCK  heal-bad-skip.diff        changes an oracle: tests/incident/pismo-4412.spec.ts    +test.skip(process.env.CI === 'true', 'flaky in CI')
ALLOW  heal-ok-transport.diff
```

**Why the contract→test step uses no LLM.** When the oracle *is* the contract, a deterministic generator is reproducible, reviewable as a diff, and can't hallucinate a status code. Using an LLM there adds variance and nothing else.

## 2. Where AI does add value, at scale

1. **Case proposal (breadth).** *(Design; not built in this repo.)* An LLM reads the contract, the C3a findings and the hearsay, and proposes behavioural cases ("amount 0.004 rounds to zero"). Output is a *draft* with `oracle.authority = UNSET` and `expected = UNSET`. **A human fills both.** The generated code can't compile into the suite with `UNSET` (it is a type error), so an unreviewed oracle is mechanically impossible.
2. **Transcription.** Turning a reviewed case table (C4) into code using the fixtures. Diff-reviewed like any PR.
3. **Maintenance ("heal") of transport-level breakage.** A renamed header, a moved base path, a new required auth header, a timeout. Allowed, because it changes *how we talk*, not *what we believe*. Heal-guard enforces the boundary.
4. **Triage assistance.** Summarising failure clusters from the flake census (transport vs oracle failures, C2 §4.2). This is advisory only; it never changes a verdict.

## 3. The hard part: stopping a heal from going green on a broken app

A "self-healing" step sees red, edits until green, and has no idea whether red was the *test* being wrong or the *app* being wrong. Against a broken app, the cheapest path to green is to change the expectation. The guardrail therefore has to be **mechanical, not judgement-based**:

1. **Oracle lines are off-limits** (heal-guard). Any added or removed line in `tests/` containing `expect(`, a matcher, `oracle(`, `test.skip/fail/fixme/only`, `knownMockDivergence`, `allowContractViolation`, or a retry setting gives BLOCK. A net deletion of tests gives BLOCK.
2. **Sources of truth are off-limits.** `contract/`, the validator, `oracle.ts`, the mock-divergence register, `risks.ts`, consumer pacts, the perf SLOs (`perf/slo.json`) and `playwright.config.ts` (retries/flaky policy). BLOCK.
3. **CODEOWNERS** on all of the above: even a human-approved bot PR needs the payments lead or the QA owner.
4. **A heal must keep its teeth.** After any heal, the mutation run must show *the same faults killed by the same tests*. A healed test that no longer kills its fault is rejected even if it is green.
5. **A heal must be explainable from a non-test change.** The bot must cite the upstream change (a contract diff or a config change) that caused the break. "Test was red; now green" with no upstream cause is auto-rejected. If nothing upstream changed and a test went red, **the app is the suspect**.

**A known weakness I'm leaving visible:** the generated cases assert only that a malformed request is *rejected* (status ∈ documented 4xx), not *why*. A server that rejects for an unrelated reason (e.g. a missing idempotency key) passes. I mitigated the obvious instance: generated `POST /transactions` cases always send a key, so a type error is the only remaining reason to reject. The general fix needs error codes in `errorResponse` (CF-15), which the contract doesn't have.

## 4. Measuring whether automation is net-positive

| Rate | Definition | How measured | Threshold |
|---|---|---|---|
| **False-pass rate** | Seeded defects not caught ÷ seeded defects | Mutation run (`reports/mutation.json`) **before and after** each AI-authored change; per-test kill map | Any new P0 survivor means the change is rejected; any P0 survivor in a week means auto-heal is disabled |
| **False-fail rate** | Failures on a known-good baseline ÷ runs | The fault-fake baseline (no faults) plus re-running the last released build | > 1% means the AI-authored tests go back to draft |
| **Heal precision** | Heals later judged correct ÷ heals accepted | Weekly human sample (20 heals), labelled correct / masked-a-defect / unnecessary | < 95% means heals require review per change |
| **Escape attribution** | Prod defects whose guarding test was AI-generated or healed in the last 30 days | Postmortem field | Any one triggers a review of the policy |
| **Net value** | (defects caught by AI-authored tests + engineer hours saved) − (review hours + cost of escapes) | Monthly | Must stay positive or the scope shrinks |

## 5. Where I refuse to let AI near this service

- **Deciding oracles for money semantics:** sign, rounding, unit, idempotency semantics, amount limits. These are exactly where the contract is silent, and silence is where an AI invents. I watched it happen while building this (see AI_NOTES): an AI-drafted test claimed "empty body means 400" **on contract authority**, but the contract equally allows 422.
- **Auto-healing any @p0 test** (T1, sign, amounts, idempotency). Red is the signal; a human reads it.
- **Editing the contract or the consumer pacts.** These are agreements between teams, not code.
- **Writing production alert thresholds or waiving a blocking question.** These are accountability decisions.
- **Touching production data or generating realistic PII.** Test document numbers are synthetic (`9…` namespace) by construction.
- **Release go/no-go.** The dashboard informs a human decision.
