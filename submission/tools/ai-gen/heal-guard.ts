/**
 * T4 guardrail: stops an AI / "self-healing" step from healing a test into green.
 *
 * Runs on every PR authored or modified by an automation bot (and is cheap
 * enough to run on all PRs). Input is a unified diff. The rule is simple and
 * mechanical, so nobody has to judge whether the AI "meant well":
 *
 *   A heal may change HOW we talk to the service (transport, config, data
 *   builders, selectors, timeouts within a cap). It may NEVER change WHAT
 *   we believe the service must do (assertions, oracles, expected statuses,
 *   skips, expected failures, the contract, the validator, or the
 *   mock-divergence register).
 *
 *   npm run heal-guard -- path/to/change.diff        # exit 1 = needs a human
 *   git diff origin/main | npm run heal-guard -- -
 */
import fs from 'node:fs';

/** Files a bot may never touch: the sources of truth for what "correct" means. */
const PROTECTED_FILES = [
  /^contract\//,
  /^framework\/contract\//,
  /^framework\/oracle\.ts$/,
  /^framework\/mock-divergences\.ts$/,
  /^framework\/risks\.ts$/,
  /^consumers\//,
  /^perf\/slo\.json$/, // performance SLOs: a bot must not relax a threshold to get green
  /^playwright\.config\.ts$/, // retries / failOnFlakyTests live here
];

/** Line patterns that encode an oracle. Changing one inside tests/ is a semantic change. */
const ORACLE_LINE = [
  /\bexpect(\.soft)?\(/,
  /\.(toBe|toEqual|toContain|toHaveLength|toMatchObject|toBeTruthy|toBeFalsy|toHaveProperty|toThrow)\(/,
  /\boracle\(/,
  /\btest\.(skip|fixme|fail|only)\(/,
  /\bknownMockDivergence\(/,
  /\ballowContractViolation\(/,
  /\bNEEDS_REAL_SERVICE\b/,
  /\bretries\b|\brepeatEach\b|\bfailOnFlakyTests\b/,
];

interface Verdict { file: string; line: string; reason: string }

function check(diff: string): Verdict[] {
  const out: Verdict[] = [];
  let file = '';
  let removedTests = 0;
  let addedTests = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.replace(/^\+\+\+ (b\/)?/, '').trim(); continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('@@') || raw.startsWith('index ')) continue;
    const sign = raw[0];
    if (sign !== '+' && sign !== '-') continue;
    const line = raw.slice(1);
    if (PROTECTED_FILES.some((r) => r.test(file))) {
      out.push({ file, line: raw, reason: 'protected file (source of truth for correctness)' });
      continue;
    }
    if (file.startsWith('tests/')) {
      if (/^\s*(test|it)\(/.test(line)) sign === '-' ? removedTests++ : addedTests++;
      if (ORACLE_LINE.some((r) => r.test(line)) && !/^\s*\/\//.test(line)) {
        out.push({ file, line: raw, reason: 'changes an oracle (assertion / skip / expected-failure / gate opt-out)' });
      }
    }
  }
  if (removedTests > addedTests) out.push({ file: '*', line: `-${removedTests} +${addedTests} test declarations`, reason: 'net deletion of tests' });
  return out;
}

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error('usage: heal-guard <diff-file|-> [...]'); process.exit(2); }
let blocked = 0;
for (const f of inputs) {
  const diff = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8');
  const v = check(diff);
  console.log(`${v.length ? 'BLOCK' : 'ALLOW'}  ${f}`);
  for (const x of v) console.log(`         ${x.reason}: ${x.file}  ${x.line.trim().slice(0, 110)}`);
  if (v.length) blocked++;
}
process.exit(blocked ? 1 : 0);
