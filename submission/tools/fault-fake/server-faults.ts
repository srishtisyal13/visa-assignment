/** Catalogue of injectable faults. Each mirrors a predicted implementation defect (docs/C5 register 2), except `sign`, a plain sign-table mistake kept as a basic control. */
export const ALL_FAULTS = {
  'idem-race': 'Idempotency check-then-insert without a lock (PISMO-4412 mechanism H-A)',
  'no-idem': 'Idempotency header ignored entirely',
  'idem-body-blind': 'Key reuse with a different body replays the first response instead of rejecting',
  'sign': 'Credit vouchers (op 4) stored as debits (negative)',
  'float-minor': 'Rupees->paise conversion truncates (Math.floor(x*100)) so 0.29 becomes 0.28',
  'negative-flips': 'Negative input amounts accepted; sign rule applied to abs() of the opposite sign',
  'dup-doc': 'Duplicate document numbers accepted',
  'dup-doc-race': 'Uniqueness enforced by check-then-insert (no DB constraint): concurrent creates both succeed',
  'no-doc-validation': 'document_number not validated',
  'no-request-id': 'No X-Request-Id on responses',
  'unknown-op-accepted': 'Unknown operation_type_id accepted as a debit',
  'ignore-unknown-fields': 'Unknown request fields (e.g. currency) silently ignored',
} as const;
export type Fault = keyof typeof ALL_FAULTS;
