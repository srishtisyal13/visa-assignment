/**
 * Every case states its oracle: what is asserted and on whose authority.
 * The annotation shows up in the HTML/JSON report next to the result, so a
 * reader of a red (or green) test can see straight away what it was claiming.
 */
import { test } from '@playwright/test';

export type Authority =
  /** The YAML says so; a reference to the exact location is required. */
  | 'contract'
  /** The backend engineer said so in standup (H1–H6). Not binding. */
  | 'hearsay'
  /** Money-movement domain reasoning (what a payments system must do). */
  | 'domain'
  /** My own assumption, to be confirmed with dev/PO (see open questions). */
  | 'assumption';

export interface Oracle {
  authority: Authority;
  /** One sentence: what is asserted. */
  asserts: string;
  /** Anchor: YAML line / pointer, hearsay id, or open-question id. */
  source: string;
  /** C1 risk id(s) this case retires, e.g. ['R1']. */
  risks: string[];
}

export function oracle(...oracles: Oracle[]) {
  const info = test.info();
  for (const o of oracles) {
    info.annotations.push({
      type: `oracle:${o.authority}`,
      description: `${o.asserts}  [source: ${o.source}] [risks: ${o.risks.join(',')}]`,
    });
  }
}

/**
 * Behavioural assertions need a real implementation. On a stateless target
 * (Prism) the test is SKIPPED with this reason. It is never run, because a
 * pass there would only echo the spec's example values.
 */
export const NEEDS_REAL_SERVICE =
  'Behavioural oracle: a stateless spec mock returns example values regardless of input, so a pass or fail here would be coincidence (mock trap). Runs on staging/fake.';
