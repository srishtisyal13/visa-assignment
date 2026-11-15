/**
 * Risk ids from docs/C1-test-strategy.md §1. Tests reference these ids in their
 * oracle so the traceability matrix (docs/C4) can be generated from the code.
 */
export const RISKS = {
  R1: 'P0 Double charge: duplicate transaction from retries/concurrency (idempotency failure)',
  R2: 'P0 Wrong money: wrong sign, wrong amount, precision/rounding loss, unit confusion',
  R3: 'P0 Misattributed money: transaction against wrong/non-existent account or unknown operation type',
  R4: 'P0 Lost or divergent audit trail',
  R5: 'P0 Unauthorised money movement (no authN/Z in contract)',
  R6: 'P1 Consumer break: contract drift breaks ledger/mobile parsing',
  R7: 'P1 Identity integrity: duplicate/invalid document numbers',
  R8: 'P2 Robustness: malformed/oversized input causes 5xx, hangs, or partial writes',
  R9: 'P2 Untraceable failures: no request correlation in incidents',
  R10: 'P3 Latency/throughput degradation',
} as const;
export type RiskId = keyof typeof RISKS;
