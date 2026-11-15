/**
 * Test-data management.
 *
 * Shared-state rule: tests never depend on data they did not create, and never
 * assert on global state (e.g. "total number of accounts"). Every datum is
 * namespaced by run + shard + worker + counter, so 200 parallel tests against one shared
 * staging database cannot collide, and a failing test's data is traceable back
 * to the run that created it.
 *
 * The contract offers no DELETE and no tenant/tag field, so "teardown" cannot
 * delete anything through the API. Instead every created resource is recorded
 * in a ledger (see ResourceLedger) that an out-of-band janitor can purge, and
 * test accounts carry a recognisable document-number prefix.
 */
import crypto from 'node:crypto';

/**
 * The run id. In CI it is github.run_id, shared by every job and shard of one run; locally,
 * playwright.config.ts sets a random one so all workers of a run share it. It tags requests
 * (x-qa-run-id), idempotency keys and the teardown manifest.
 */
export const RUN_ID = process.env.RUN_ID ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Last 6 digits of a numeric run id: distinct across a million consecutive CI runs. */
const RUN_DIGITS = (/^\d+$/.test(RUN_ID) ? RUN_ID : String(crypto.randomInt(0, 1_000_000))).slice(-6).padStart(6, '0');

/** Prefix marking synthetic test accounts. ASSUMPTION: document numbers are numeric (hearsay H4). */
export const TEST_DOC_PREFIX = '9';

export class DataFactory {
  private counter = 0;
  /**
   * shard: Playwright's --shard index (0 when not sharded). The shards of one CI run share RUN_ID
   * and each restarts its worker indexes at 0, so the shard has to be part of the namespace.
   */
  constructor(private readonly workerIndex: number, private readonly shard = 0) {}

  /**
   * Unique numeric document number. The default is 14 digits, the top of the "10 to 14" range
   * (hearsay H4), so the whole namespace fits: 9 | run(6) | shard(1) | worker(2) | counter(4).
   * Shorter boundary values can't hold it and use digits from a hash of the namespace instead.
   */
  documentNumber(length = 14): string {
    const n = ++this.counter;
    const core = `${TEST_DOC_PREFIX}${RUN_DIGITS}${this.shard % 10}${String(this.workerIndex % 100).padStart(2, '0')}`;
    const room = length - core.length;
    if (room < 4) {
      const h = crypto.createHash('sha256').update(`${core}-${n}`).digest('hex');
      return TEST_DOC_PREFIX + BigInt('0x' + h).toString().slice(0, length - 1);
    }
    return core + String(n).padStart(room, '0');
  }

  /** Unique idempotency key traceable to this run. */
  idempotencyKey(label = 'k'): string {
    return `qa-${RUN_ID}-w${this.workerIndex}-${label}-${crypto.randomUUID()}`;
  }

  requestId(): string {
    return `qa-${RUN_ID}-${crypto.randomUUID()}`;
  }
}

export interface CreatedResource { kind: 'account' | 'transaction'; id: unknown; test: string; runId: string }

/** Records everything a test created (teardown manifest for the janitor). */
export class ResourceLedger {
  readonly items: CreatedResource[] = [];
  constructor(private readonly testTitle: string) {}
  record(kind: CreatedResource['kind'], id: unknown) {
    this.items.push({ kind, id, test: this.testTitle, runId: RUN_ID });
  }
}
