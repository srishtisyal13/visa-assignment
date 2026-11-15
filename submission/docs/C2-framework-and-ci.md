# C2: Test framework and CI design

The goal is a capability the squad lives in, not a folder of scripts. It is designed for engineers who are not me to add tests safely, and for the target to move from mock to staging without a rewrite.

## 1. Architecture

```
 tests/<layer>/*.spec.ts           <- authors write ONLY here: domain verbs + oracle() + expect
        │  import { test, expect } from framework/fixtures
        ▼
 framework/fixtures.ts             <- Playwright fixtures: api, caps, data, ledger, account, contract
        │                              + automatic contract gate + teardown manifest
        ├── framework/client/transactions-client.ts   service abstraction over APIRequestContext
        │        └── every response → framework/contract/validator.ts (schema-driven, from YAML)
        ├── framework/data/test-data.ts               namespaced data factory + resource ledger
        ├── framework/oracle.ts                       oracle authority annotations
        ├── framework/mock-divergences.ts             self-expiring register of mock infidelities
        └── framework/config/targets.ts   ◄══ THE SEAM: target = baseURL + declared capabilities
                     │                          (deployed environments listed in environments.json)
      ┌──────────────┼───────────────────────────┬─────────────────────────────────────┐
  TARGET=mock    TARGET=fake                 TARGET=staging | uat | preprod | <any entry>
  Prism v1 :4010 tools/fault-fake :4020      URL: <ENV>_URL or TARGET_URL
  Prism v1.1 :4011 (T1 only)  (FAULTS=…)     settings: environments.json, overridable by env vars
```

| Concern | How it is handled | File |
|---|---|---|
| **Fixtures** | `api`, `caps`, `data`, `ledger`, `account` (a fresh account per test, created lazily), `contract`. Projects set `incident: true` to switch base URL. | `framework/fixtures.ts` |
| **Service abstraction** | `createAccount`, `getAccount`, `createTransaction(body, {idempotencyKey})`, `listTransactions`, `raw()` for malformed, oversized or wrong-type requests. Header names come from the target, not from tests. | `framework/client/` |
| **Contract layer** | Every response is validated against the target's contract file automatically. A violation fails the test unless the test opts out *with a reason* (`allowContractViolation`) that lands in the report. | `framework/contract/validator.ts` |
| **Config / env switching** | One env var, `TARGET`: `mock`, `fake`, or any deployed environment listed in `environments.json` (staging, uat, preprod). Environment differences are **capabilities** and settings, not code: `transactionListing`, `contractFile`, `idempotencyHeader`, `requestIdHeader`, `requestTimeoutMs`. The URL comes from `<ENV>_URL` (e.g. `UAT_URL`) or `TARGET_URL`; any setting can be overridden by its env var. Adding an environment is a JSON entry, not a code change. An unknown `TARGET`, a missing URL or a missing contract file fails at start-up with a message that says what to set. | `framework/config/targets.ts`, `framework/config/environments.json` |
| **Test data** | Every document number is namespaced `9 · run(6) · shard(1) · worker(2) · counter(4)` (14 digits), so parallel shards and separate runs cannot collide. Tests never read data they did not create and never assert global state. | `framework/data/test-data.ts` |
| **Teardown** | The API has no DELETE (CF-11). Pretending to clean up would be a lie, so every created id is written to `reports/created-resources/*.jsonl` for an out-of-band janitor, and test accounts carry the `9…` prefix. | `fixtures.ts` (`ledger`) |
| **Oracles** | `oracle({authority, asserts, source, risks})` is attached to the report. `risks` feeds the generated traceability matrix, which **fails the build** for a case that retires no risk. | `framework/oracle.ts`, `tools/traceability/` |

### The seam: why mock → staging is cheap
Tests never ask "am I on the mock?". They ask **capabilities**:
- `caps.stateful === false` means behavioural oracles are **skipped** with the reason *"a stateless spec mock returns example values regardless of input"*. Without that, a sign test for op 1 would pass on the mock because the spec example happens to be `-100.5`. That is the mock trap, made structurally impossible.
- `caps.transactionListing === false` means the T1 test **fails** with "NOT VERIFIABLE… sign-off BLOCKED". It does not skip. A guardrail that cannot see must not be green.

Pointing at a real environment is `TARGET=staging STAGING_URL=…` (or `TARGET=uat UAT_URL=…`, and so on). I ran the full suite this way as `TARGET=uat` against a local stand-in, with no test or code change (the whole suite passed), and as a test, added a temporary `qa` environment by editing only `environments.json` (then removed it). In CI, each deployed environment is a GitHub environment of the same name holding its own `TARGET_URL` and settings; the nightly jobs run once per environment marked `"nightly": true`, and pre-release runs against the environment chosen when it is triggered. When the provider ships the read path, set `CAP_TRANSACTION_LISTING=true` **and** point `CONTRACT_FILE` at the contract that declares it. I ran exactly this, with an unchanged test, against a local stand-in: T1 failed as NOT VERIFIABLE without the capability, still failed with the flag alone (the automatic contract gate correctly rejected the read path as an undeclared operation), and passed with both set.

### Rules for engineers adding a test (also in the file headers)
1. Import `test` from `framework/fixtures`, never from `@playwright/test`.
2. Call `oracle(...)` first, with authority, source (YAML line / H-id / OQ-id) and risk id.
3. Behavioural oracle? Add `test.beforeEach(({caps}) => test.skip(!caps.stateful, NEEDS_REAL_SERVICE))`.
4. Create what you assert on (use the `account` fixture or `data.*`). Never assert counts outside your own account.
5. Tags: `@pr` (must run in under 30 s total per file), `@nightly` (slow or heavy), `@p0` (never quarantined, and never retried into green: CI's one retry only captures a trace, `failOnFlakyTests` turns a pass-on-retry into a red build, and pre-release runs @p0 with zero retries).

## 2. Proving the tests can fail: the fault-injection fake
A green suite is only evidence if the suite can go red. `tools/fault-fake` is a small stateful server implementing *my assumed* v1.1 semantics, with 12 switchable defects. Each one mirrors a C5 prediction (`idem-race`, `float-minor`, `negative-flips`, …), except `sign`, a plain sign-table mistake kept as a basic control. `npm run test:mutation` runs the suite once per fault:

- **Baseline (no faults) must be 100% green.** Any failure there is a **false fail**.
- **Every P0 fault must be killed.** A survivor is a **false pass**.
- Current result: **12/12 killed (8/8 P0), baseline 80/80 green** (written to `reports/mutation-report.md` by `npm run test:mutation`; `reports/` is generated, not committed).
- One telling detail: `idem-race` (the PISMO-4412 mechanism) is killed **only by T1-01**. Every sequential idempotency test passes against it. That is the quantitative argument for T1 as its own gate.

The fake is labelled everywhere as **not a model of the service**. Passing against it proves the tests agree with my assumptions and have teeth, nothing more.

## 3. CI pipeline (`.github/workflows/quality-gates.yml`)

| Gate | Budget | Runs | Why here |
|---|---|---|---|
| **Per-PR · static** | ~3 min | typecheck · validator self-tests · generated-tests freshness vs contract · heal-guard on bot PRs · consumer can-i-deploy (v1 informational, v1.1 blocking) | Cheapest, deterministic, catches authoring errors and contract/consumer breaks before any HTTP |
| **Per-PR · behaviour** | ~6 min | full suite vs Prism (harness) · full suite vs fake (baseline) · **mutation run** · traceability matrix | Proves the harness, the oracles and their teeth with **no shared environment**, so PR results can't flake on staging state |
| *Per-PR (target state)* | +8 min | same suite with `TARGET=staging` against an **ephemeral build of the service** (docker compose in the service repo's PR) | Once we have repo access. This is where behaviour is first tested for real. |
| **Nightly** | ~45 min per environment | for each environment marked `"nightly": true` in `environments.json` (today staging and uat): full suite, 4 shards · T1 at N=50 × 5 rounds · drift probe (alerts on *new* drift, separate baseline per environment) · consumer live replay. Plus a **flake census** on staging (`--repeat-each=10 --retries=0` on @p0), and the **JMeter perf run** (T2) for each environment marked `"perf": true`, after the other nightly jobs on that environment and one environment at a time | Real state, real latency; too slow or too shared for PR; trend data for the dashboard |
| **Pre-release** | ~60 min, manual | against the environment chosen at dispatch (default staging): @p0 with **retries=0** · **perf SLOs** (T2, blocking) · T1 at **N=200 × 20 rounds** · can-i-deploy against the contract being released · evidence archived for 400 days | Highest confidence for the money paths; evidence is retained for audit |

Ordering principle: **fast → slow, cheap → expensive, isolated → shared.** Nothing that touches shared state runs per-PR. Nothing per-PR depends on a mock example being "right".

## 4. Flake and environment strategy

**4.1 Determinism against shared state.** The account is the tenant. Every test creates its own account(s), and every assertion is scoped to that account (its transactions, its net movement). No test reads global counts, "latest" records or fixed ids. Idempotency keys and request IDs are UUID-based and carry `RUN_ID`. Time is never asserted beyond "parseable" and "UTC".

**4.2 Telling a genuine intermittent defect from flake (retries hide real bugs).**
- **A retry is a diagnostic, never a pass.** CI allows 1 retry *to capture a trace*, and `failOnFlakyTests: true` turns "passed on retry" into a red build. @p0 tests run with `retries=0` in pre-release.
- **Classify by signature, not by feeling.** For every flip, the census records failing assertion, status histogram, latency and target. *Infrastructure flake* fails in transport (timeouts, ECONNRESET, DNS), independent of assertion and load. A *product intermittent* fails **on an oracle** (count = 2, wrong sign) and its rate **rises with concurrency**. Reproduce with `--repeat-each` and a higher `T1_CONCURRENCY`: a rate that scales with N is a race, not flake.
- **Concurrency tests are expected to be probabilistic.** One red T1 run is a P0 defect until disproven. It is never "flaky".
- **Quarantine** exists, with an owner and a 7-day expiry, and quarantined tests still run and report. **@p0 tests cannot be quarantined.** The heal-guard and CODEOWNERS enforce this.

**4.3 Two hundred tests in parallel without a per-test environment.** Isolation by **data partitioning**, not environments: 200 workers × own accounts means zero shared rows. Uniqueness comes from the namespace scheme: run, shard and worker are all part of every document number, so it is collision-free across workers, shards and runs. I checked it by running two shards of one run in parallel against one shared service: all 119 tests passed, with no duplicate-document rejections. Load on shared staging is bounded by sharding (4 × N workers) and a per-worker rate limit if the provider imposes one. The only cross-test interference left is capacity (latency), which the census separates from oracle failures (4.2).

**4.4 A real example from building this.** Against the fake, a *different* test failed on each run (ID-02, then ID-03) with a 5 s timeout on `POST /accounts`. The failing test was always the one after **XC-14** (1 MiB body) in the same worker. Cause: the fake answered 413 and abandoned the socket mid-upload. Playwright's worker pooled that half-written keep-alive connection, and the next test's request hung on it. That is a **test-isolation leak through the connection pool**, not a flaky service and not a flaky test. Retrying would have "fixed" it and hidden it. The fix was on both sides: the server drains and closes, and the oversized test sends `Connection: close`. The lesson went into the rules: tests that send hostile bodies must not share sockets.
