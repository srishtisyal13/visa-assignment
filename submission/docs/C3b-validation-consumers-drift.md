# C3b: Schema-driven validation, consumer-driven contracts, mock fidelity

> Note: the brief's C3b line is truncated after "Schema-driven". I read it as "build a schema-driven validation layer", meaning validation derived from the contract rather than hand-written assertions. If more was intended, I'd want to know.

## 1. The validation layer (`framework/contract/validator.ts`)

**What it does.** It loads the Swagger 2.0 YAML and, for any observed exchange, checks: (1) the operation exists; (2) the status is documented for that operation (undeclared methods are checked against the declared 405 schema); (3) the content-type is in `produces`; (4) the body validates against the response schema (Ajv). It also validates **request** bodies (`validateRequestBody`) and lists declared header parameters. Nothing about the API is hard-coded: change the YAML and the validator changes with it.

**How it is wired.** Every response passing through the client is validated **automatically**. A violation fails the test in fixture teardown, unless the test opts out with `allowContractViolation(api, reason)`, and the reason is printed in the report. A new engineer gets contract checking without knowing it exists, and cannot silently turn it off.

**Two strictness levels.**
- `contract` checks exactly what the YAML says, and is used for verdicts.
- `strict` additionally forbids undeclared response fields. The contract is silent on `additionalProperties`, so this is an **assumption** used only for **drift detection**, never as a verdict.

**It is itself tested** (`tests/unit/validator.spec.ts`, 12 tests, no network). The validator must *catch* wrong types, undocumented statuses and wrong media types. And it must *accept* `{}` and op type `99` under v1, because those accepted cases are the machine-checked evidence for CF-02/03/05/07/08. If the provider tightens the contract, those tests flip, and that is the signal to update the audit.

**Bugs found while building it** (kept here because they are exactly the class of error a validator layer hides):
- Swagger 2.0 is JSON-Schema draft-4, where `exclusiveMinimum` is a *boolean*. Ajv speaks draft-07, where it is a number. The first run crashed on the proposed contract. The fix translates the keyword. Without it, the validator would have rejected *valid* schemas, or, with a lax setting, silently ignored the minimum.
- Shared parameters (`$ref: '#/parameters/…'`) weren't resolved, so the validator reported "no headers" for the proposed contract. A self-test caught it.

## 2. Consumer-driven contracts: mobile app and ledger service

The two consumers need **different** contracts from the same provider, and that is the point:

| Need | Mobile app (tolerant reader) | Ledger service (system of record) |
|---|---|---|
| Fields | `account_id`, `document_number`, `transaction_id`, `amount`, `type`, `event_date`. Ignores extras. | **All** transaction fields, **required**, exact types |
| Enums | `type` ∈ {debit, credit} for display colour/sign | `type` **and** `operation_type_id` closed enums; an unknown value must never reach the GL |
| Errors | `error: string`, human-readable, on 400 | Must be able to rely on unknown op types being **rejected** upstream (422) |
| Retries | `Idempotency-Key` for safe retry on flaky networks | `Idempotency-Key` plus **read-back** for dedupe and reconciliation |
| Time | `event_date` parseable, for display | `event_date` RFC 3339 UTC, defined as **booking** time |
| Read paths | GET account | `GET /accounts/{id}/transactions` (nightly reconciliation) |

Encoded as Pact-style files: `consumers/mobile-app.pact.json` (4 interactions) and `consumers/ledger-service.pact.json` (3 interactions). `npm run consumers:verify` checks them against any provider contract:

```
vs published v1:        7/7 interactions FAIL   (optional fields, no enums, no header, no read path, 99 accepted)
vs proposed v1.1:       7/7 ok
```

So the published contract **cannot honour either consumer's needs as written**. That is a concrete, consumer-attributed form of CF-01/03/07/08/22.

**How the provider is stopped from breaking either consumer:**
1. **Consumers own their pacts.** They live in the consumer repos and are published to a Pact Broker on every consumer merge, tagged by environment.
2. **Provider PR gate: can-i-deploy.** The provider's PR (a) checks every consumer pact against the *new* contract statically, which is what `consumers:verify` does here, and (b) replays the pacts against the *built* provider (`--live`), which is provider verification. Either failing blocks merge. Consumers are only affected by fields **they** declared, so the mobile app's tolerance doesn't loosen the ledger's strictness.
3. **Expand → migrate → contract.** Breaking changes ship as additive first (new field or enum value behind a version), consumers migrate, and then the old shape is removed only when can-i-deploy shows no consumer still depends on it. Adding a value to a closed enum (e.g. `type: reversal`) **is** a breaking change for the ledger and is treated as one.
4. **Contract diffs need consumer-side review.** CODEOWNERS on `contract/` includes the ledger team.

*In production this is pact-js + broker + `can-i-deploy`. The repo version runs offline with no broker, so a reviewer can execute it.*

## 3. Generated contract tests
`npm run generate:tests` writes `tests/generated/contract-negative.generated.spec.ts` (19 cases: every typed field × wrong JSON types, required body absent, non-integer path param) deterministically from the YAML. CI runs `--check` and fails if the committed tests are stale against the contract. See T4 for why this step deliberately has no LLM.

## 4. Mock fidelity and drift

**What the mock is faithful to.** A spec-generated mock is faithful **to the spec**, not to the service. Its fidelity to the service is zero by construction. So there are three different "drifts", and each needs its own detector:

| Drift | Detector | Status today |
|---|---|---|
| **Mock vs contract** (the mock doesn't even honour its spec) | `npm run drift:check -- --target <mock>` plus the `MOCK-*` register | **Found 3** (below) |
| **Service vs contract** (reality differs from the published claim) | Same probe against staging nightly; the full suite's automatic contract gate | Needs staging |
| **Contract vs consumers' needs** | `consumers:verify` | 7/7 fail on v1 |

**Mock-vs-contract findings from probing Prism (first found on 5.12.0, all re-checked on the pinned 5.16.0, all reproducible):**
- **MOCK-1:** 405s are `application/problem+json` with `type/title/status/detail`, not the declared `errorResponse` / `application/json`.
- **MOCK-2:** malformed JSON: Prism *never answers* some clients (curl and Node's `fetch` hang until timeout), which no declared response allows. Playwright's client does get a documented status (400 on `POST /accounts`, 422 on `POST /transactions`), so no test is marked for it.
- **MOCK-3:** every error body is the spec example `{"error":"account not found"}`, including for a malformed document number.
- Also: `POST /transactions {}` returns **201** (correct per v1, because of CF-03), and an undeclared `sl-violations` header appears on error responses.

**Keeping it honest:**
1. **Divergences are a register, not folklore.** An entry that affects an assertion marks that test `test.fail()` *on the mock only* (today MOCK-1, on the four CT-20 tests; MOCK-2 and MOCK-3 affect no assertion in the suite). If Prism is fixed, the test "unexpectedly passes" and the build tells us to delete the entry. The register can't go stale silently.
2. **The same tests run on mock and staging.** Behavioural tests are *skipped* on the mock, never passed, so a mock can't manufacture green on the things that matter.
3. **Pin the mock version** (`@stoplight/prism-cli` exactly `5.16.0` in `package.json`, locked in `package-lock.json`) so its behaviour changes only by PR. The 5.12.0 → 5.16.0 upgrade is an example: the full suite, the mutation run and the traceability matrix gave identical results before and after.
4. **Detect production drift continuously.** The nightly drift probe hits staging with the fixed contract-derived probe set and **alerts on changes vs the previous baseline** (new undocumented status, new field, new header), not on known drift, so it doesn't become noise. In production, the same validator runs **passively** over sampled real traffic (an API-gateway log sample or a consumer-side tap), counting violations per operation. A non-zero rate on a money field pages; anything else becomes a ticket.
5. **Record and replay to improve the mock**, once staging exists: capture real responses for the contract-derived probes, review them, and serve those as the mock's examples. The mock then reflects observed behaviour, tagged with the date and build it was recorded from, and the drift probe shows when that recording is out of date.
