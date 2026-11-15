# T2: Performance testing

**What is built:** a JMeter plan for `POST /transactions` and `POST /accounts` with a same-key concurrency storm on the idempotency path ([perf/transactions.jmx](../perf/transactions.jmx)), SLOs declared as data ([perf/slo.json](../perf/slo.json)), a runner that refuses the mock ([tools/perf/run.ts](../tools/perf/run.ts)), an SLO and regression gate with unit tests ([tools/perf/check-slo.ts](../tools/perf/check-slo.ts), [tests/unit/perf-slo.spec.ts](../tests/unit/perf-slo.spec.ts)), and CI jobs that run it against staging and UAT.

**What it does not prove:** anything about the service's performance. No number in this repo has been measured against a real environment, and none will be measured against the mock (§6).

## 1. Tool: Apache JMeter 5.6.3

- **The squad already knows it.** Most performance and SRE engineers can read and change a JMeter plan, so it is the cheapest tool to hand over.
- **Open-model load without plugins.** JMeter 5.5+ ships the *Open Model Thread Group*: requests arrive at a fixed rate (Poisson arrivals) however slowly the service answers. That matters for a payment API. In a closed model (a fixed number of threads, each waiting for its reply), a slow server automatically receives fewer requests, and the slowdown hides itself (coordinated omission).
- **The idempotency storm is a native shape.** A *Synchronizing Timer* releases N threads at the same instant, which is exactly "N concurrent requests with the same key".
- **CI-friendly.** Non-GUI mode, and an HTML dashboard out of the box (`-e -o`).
- **Considered:** k6 (JavaScript scripts, thresholds as code, one binary). JMeter won on team familiarity and core open-model support. k6's two advantages are covered here another way: SLOs are code (`perf/slo.json` + `check-slo.ts` fails the build), and the plan stays reviewable (small, every element named, CODEOWNERS on `perf/`, SLO changes blocked for bots by heal-guard).
- **Costs accepted:** an XML plan is harder to review than a script; CI installs a JVM and JMeter (about a minute, checksum-verified).

## 2. SLOs, declared before the plan was written

Every number is invented, because there is no production traffic data yet. Each one is defended below and lives in `perf/slo.json`, so changing it is a reviewed diff.

| SLO | Target | Where the number comes from |
|---|---|---|
| Throughput | **50 transactions/s** and **5 accounts/s**, steady for 10 min | Assumes about 1 million card transactions a day (≈ 12/s on average) and a 4× peak-to-average ratio, so ≈ 50/s at peak. Account opening at a tenth of that. Replace with production peak × 1.5 once known. |
| `POST /transactions` latency | **p95 ≤ 300 ms, p99 ≤ 800 ms** | The write is one account lookup, one idempotency reservation, one insert and one audit row in a single DB transaction: tens of milliseconds of database time. 300 ms at p95 leaves room for network, TLS and GC. The p99 matters most: it keeps the slowest 1% far below an assumed 3 s mobile client timeout. Latency near the client timeout is what starts retry storms, which is how PISMO-4412 happened, so the tail SLO protects R1. |
| `POST /accounts` latency | **p95 ≤ 300 ms, p99 ≤ 800 ms** | Same reasoning: a uniqueness check and an insert. |
| Error rate | **≤ 0.1%** of requests not answered 201 | Matches a 99.9% availability objective. It counts 5xx, timeouts, connection errors and unexpected 4xx, because the plan only sends valid requests. |
| Same-key storm | **0 extra transactions per key**; every reply 201 or 409; contended **p95 ≤ 1 s, p99 ≤ 2 s**; 0 errors | Correctness under load is not negotiable: it is R1. Contended requests may queue behind the idempotency reservation, so their latency budget is wider. |
| Achieved throughput | **≥ 95% of the target rate** | Below that, either the service saturated or the load generator could not keep up. Either way the latency numbers can't be trusted, so the run is marked invalid rather than passed. |

**Load profile:** ramp from 0 to 50/s over 60 s (excluded from the SLOs as warm-up), then 10 minutes steady; a pool of 200 accounts created in setUp; the storm is 50 concurrent requests × 20 rounds, running while the load runs.

## 3. The plan

| Thread group | What it does |
|---|---|
| setUp | Creates the account pool (synthetic `9…` document numbers, the same test namespace as the functional suite). Stops the test if accounts can't be created. |
| load: `POST /transactions` | Open model: ramp, then steady at the target rate. Random account from the pool, every operation type 1–4, amounts 0.01–1000.00 with 2 decimals, a fresh idempotency key per request. Asserts 201. |
| load: `POST /accounts` | Open model at a tenth of the transaction rate. Asserts 201. |
| storm: same idempotency key | 50 threads, released together by a Synchronizing Timer, all sending the same key and body in each of 20 rounds. Asserts 201 or 409 and records each `transaction_id` per key. |
| tearDown: `CHECK idempotency` | Fails if any key produced more than one transaction (§4). Writes `reports/perf/idempotency.json`. |

Every setting comes from `perf/slo.json` through `-J` properties, and the target URL, idempotency header name, timeout and read-path capability come from the same environment configuration as the test suite (`framework/config/environments.json`).

## 4. The idempotency concurrency dimension

Each round, 50 identical requests with one key reach the server in the same instant, while the normal load is running: a retry storm under load, which is when PISMO-4412 happened. The tearDown check then decides:

- **with a read path** (`transactionListing` / `CAP_TRANSACTION_LISTING`): it counts the rows per key through `GET /accounts/{id}/transactions?idempotency_key=…`, exactly like T1-01. More than one row fails the gate.
- **without one** (the published v1 contract): it can only check that all 201 replies carry the same `transaction_id`. That is necessary but not sufficient (T1 §2): a server can return identical replies while writing several rows. The report says so explicitly ("distinct transaction_ids only: no read path").

The latency of the contended requests is reported separately, so a slow reservation path shows up on its own line.

## 5. Running it, and the reports

```bash
TARGET=staging STAGING_URL=https://… npm run perf              # or TARGET=uat UAT_URL=…, or any environment
npm run perf -- --history reports/perf/history.json            # also apply the regression gate
PERF_STEADY_SEC=120 PERF_TX_RATE=10 npm run perf               # lighter run (overrides any load setting)
```

Needs Apache JMeter 5.6.3 (Java 17+) on `PATH`, or `JMETER_BIN`. Everything is written to `reports/perf/`:

| File | What it is |
|---|---|
| `html/index.html` | JMeter's HTML dashboard: response times over time, percentiles, throughput, errors per request type |
| `slo-report.md`, `summary.json` | The SLO verdict per request type, failed checks and regression findings |
| `idempotency.json` | Storm result: transactions per key, and whether the count came from the read path |
| `results.jtl`, `jmeter.log` | Raw samples (CSV) and JMeter's own log |

## 6. Why there is no mock run

`npm run perf` **refuses `TARGET=mock`**. Prism answers from the spec's examples, in memory, with no database, no idempotency store and no network hop, so any latency or throughput figure would describe this laptop and Prism. The fault-injection fake is no better: an in-memory map with a fixed 15 ms sleep.

`TARGET=fake npm run perf -- --harness-check` exists only to prove the plan executes end to end (every thread group produces samples and the check runs) in about 10 seconds. Its timings are not evaluated. So what T2 claims today is limited to: the plan runs, the gate's logic is unit-tested, and the CI wiring exists.

## 7. What is needed before the numbers mean anything

- **A production-like environment:** the same instance sizes and count, the same database class with production-sized tables (index depth changes latency), and the same network path (load balancer, TLS, gateway).
- **A quiet or isolated environment.** In CI, perf never overlaps the functional nightly suite on the same environment.
- **A load generator that is not the bottleneck:** its CPU and heap watched, the same runner class every run, and the same region as the service.
- **Server-side metrics alongside** (CPU, DB connections, pool waits, GC), so a breach can be attributed rather than argued about.
- **The real traffic mix** from production logs (operation-type split, account distribution) instead of the uniform random mix.
- **A contractual idempotency header** (CF-01), so the plan sends what the real client sends.
- **A baseline:** at least three good runs per environment before the relative gate gives a verdict.

## 8. The perf regression gate

1. **Absolute SLOs** (`perf/slo.json`): fail the nightly job and block pre-release. They only become meaningful once §7 holds.
2. **Relative regression** against history, implemented in `check-slo.ts` with a history kept per environment. It is designed not to fail on infrastructure noise:
   - p95 is compared with the **median of the last 7 good runs** on the same environment, so a single noisy night cannot move the baseline;
   - a label is flagged only if p95 rose by **more than 20% and by more than 50 ms**, because a relative-only threshold fires on 12 ms → 15 ms noise;
   - labels with **fewer than 1,000 samples** get no verdict, and the 60 s ramp is excluded;
   - a first breach is **suspected** (a warning annotation; the build passes). A breach on the next run too is **confirmed** and fails the build;
   - only **valid, SLO-passing runs** enter the history, so a broken night can't drag the median;
   - a run below 95% of the target rate is **invalid**, not a regression (generator limit or saturation);
   - perf runs **after** every other nightly job on that environment (functional suite, drift probe, flake census), **one environment at a time**, on the **same runner class**.
3. **Pre-release:** absolute SLOs block. On a suspected regression, re-run once before deciding (design; the history mechanism supports it).

## 9. CI

- **Nightly** (`perf-nightly`): for each environment with `"perf": true` in `environments.json` (staging and uat), after the other nightly jobs on that environment, one at a time, each in its GitHub environment (`TARGET_URL` and settings). JMeter 5.6.3 is installed with a SHA-512 check. The history is cached per environment. The HTML dashboard, JTL and SLO report are uploaded as artifacts.
- **Pre-release:** a blocking perf step against the environment chosen at dispatch; evidence kept for 400 days.
- **Not per PR:** 11 minutes of load on a shared environment per PR is too slow and too noisy. The PR gate runs the gate's unit tests instead.
