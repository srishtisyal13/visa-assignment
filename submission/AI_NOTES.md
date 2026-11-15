# AI_NOTES

## What I used AI for

- **Reading the brief and planning:** cross-checking my list of requirements against the assignment PDF and template (that list became `design.md`, which maps each requirement to the solution I chose). The cross-check found items my list had missed (the verbatim Prism command, the contract's own "send a positive amount" sentence, contract-level facts such as `host`, no headers and no `securityDefinitions`).
- **Probing the mock:** running Prism against the contract and recording what it actually does, before writing any test that depended on it. That probing produced MOCK-1..3.
- **Scaffolding code:** fixtures, client, validator, fault-injection fake, mutation runner, consumer verifier, drift probe, generator and heal-guard. Each was run and iterated until it behaved as described.
- **Drafting the documents,** which I then edited for position and tone.

## Places it was wrong or misleading, and how each was caught

All of these were caught **by running things**, not by reading the AI's explanation of them. That is the main lesson.

1. **It invented a contract oracle.** The first draft of XC-13 asserted "empty body on `POST /transactions` gives **400**" and labelled the authority `contract`. The contract declares both 400 and 422 on that operation and never says which applies. Prism answered 422 and the test went red. The AI had picked the plausible code and claimed the contract's authority for it. That is exactly the failure mode the brief warns about. The fix: accept either, add a second oracle labelled `assumption`, and log the ambiguity as **CF-15**.
2. **It got the schema dialect wrong.** The validator was written assuming JSON-Schema draft-07. Swagger 2.0 is draft-4, where `exclusiveMinimum` is a boolean. The first run crashed on the proposed contract. Worse, a laxer Ajv setting would have *silently ignored* the minimum, so a "validated" negative amount would pass. Caught by running the validator self-tests; fixed by translating the keyword.
3. **It over-generalised a mock observation.** It recorded "Prism hangs on malformed JSON" from one curl probe. The Playwright run showed Prism answers *Playwright's* request with 422 in about 50 ms. The divergence entry (MOCK-2) now states both observations, rather than the confident but wrong one.
4. **Its fake had the bug it was predicting.** The fault-injection fake's account creation was check-then-insert, the same race the AI predicted for the real service (PD-6). Test AC-21 (10 concurrent duplicate creates) caught it with 10 accounts for one document. It was fixed, and the race was kept as a selectable fault (`dup-doc-race`).
5. **Its first instinct for an intermittent timeout was "flaky".** When a different test timed out on each run, the easy explanation was "flaky". Isolating it showed the failing test always followed the 1 MiB oversized-body test in the same worker: a poisoned keep-alive socket (C2 §4.4). A retry policy would have hidden it.
6. **It overstated a claim in a document.** The C5 draft said every prediction was modelled in the fake. Four were not. Corrected, and the missing PD-12 test (XC-15, unknown `currency` field) was added with its own fault.
7. **It drove a vulnerability count to zero by breaking the mock.** After the dependency upgrade, one `npm audit` advisory remained: Prism's bundled `postman-collection` pins a vulnerable faker 5.5.3. To clear it, the AI forced faker 10.6 with npm `overrides`. `npm install` succeeded and `npm audit` reported 0 vulnerabilities, but a clean `npm ci` followed by the suite showed Prism crashing at startup, because faker 10 removed the `faker.address` API that `postman-collection` reads when it loads. Caught by running the suite after a clean install rather than trusting the audit number. The faker override was dropped, and the advisory is documented as unreachable in SUBMISSION.md; the lodash and uuid overrides, which do work, stayed.

## A decision I made against its suggestion

**Building T2 instead of skipping it.** The AI had skipped the performance track, and when I asked about it, it defended that choice: a number from the mock only measures the laptop, and load matters here mainly as a trigger for retry storms, which T1 already covers. I disagreed. The brief asks to be honest about what a mock run measures, not to skip the work, and a plan, declared SLOs and CI against real environments are useful before any number exists: they are ready the day an environment is. So T2 was built: a JMeter plan with a same-key storm on the idempotency path, SLOs as a build gate, a runner that refuses the mock, and nightly and pre-release jobs against staging and UAT. Run against the fake with the `idem-race` fault, its storm check failed with 5 transactions per key, so the performance track catches the PISMO-4412 class as well.

**Exact versions, not "pinned" in name only.** The AI-built `package.json` used caret ranges (`"@stoplight/prism-cli": "^5.12.0"`) while the docs called Prism "pinned", and when `npm audit` flagged vulnerable dependencies its proposal was `npm audit fix` within those ranges. I required exact versions for Prism and Playwright in `package.json`, chosen for the fewest known vulnerabilities, with every run repeated after the change. The mock-divergence register and its expected-failure tests depend on Prism's exact behaviour, so the mock should change only through a reviewed PR, and "pinned" should hold for a plain `npm install`, not only for `npm ci`.

**JMeter instead of k6 for T2.** The AI proposed k6 (JavaScript scripts, thresholds as code, a single binary). I chose JMeter, because I know it and it is what performance engineers on most squads can maintain. The AI's two arguments for k6 are covered another way: the SLOs live as data in `perf/slo.json` and a small gate fails the build on a breach, and JMeter's core Open Model Thread Group gives fixed-rate load without plugins.

## How I'd defend any generated line

Every test's `oracle(...)` names its authority and source line. Every contract finding is anchored to a YAML line and, where possible, asserted by a unit test. Every predicted defect names the test that would refute it. If I can't trace a line to one of those, it shouldn't be in the repo.
