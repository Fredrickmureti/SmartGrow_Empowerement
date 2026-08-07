# ADR 0130 — POS and payroll reverse through the same governance as finance

Status: accepted
Date: 2026-08-07
Related: ADR 0123 (posting monopoly), ADR 0125–0128 (canonical reversal writers),
ADR 0129 (reversal intent authority, reason taxonomy, approval thresholds, register)

## Context

Phases 5.1–5.3 gave finance documents one reversal authority
(`resolve_reversal_intent`), one gate (`assert_can_reverse`), one reason
taxonomy (`reversal_reason_codes`) and one approval policy
(`reversal_approval_requirement`). Phase 5.4 added the cross-module audit
register.

POS and payroll stayed outside all of it. `process_pos_void` validated against
its own `pos_void_reasons` table and its own manager-override matrix;
`payroll_reverse_run_atomic` validated with `assert_can_reverse_payroll` only.
Neither consulted the intent authority, so the platform could not answer "what
are my options for unwinding this sale / this payroll run?" in the same terms as
for an invoice, and neither honoured the organisation's reversal approval
thresholds or the reason vocabulary.

## Decision

1. **`resolve_reversal_intent` becomes a dispatcher.** The five-document finance
   body is renamed to `resolve_reversal_intent_finance`; `pos_transaction` and
   `payroll_run` are answered by `resolve_reversal_intent_pos` /
   `resolve_reversal_intent_payroll`, which return the identical jsonb contract
   (`state`, `blockers`, `operations`, `recommended`). Callers keep one entry
   point.
   - POS operations: `void` (same open shift, no return against the sale, open
     period), `refund_sale`, `return_goods`. New blockers: `returned`,
     `shift_closed`.
   - Payroll operations: `reverse_run` (posted/paid, open period),
     `correction_run`. New blocker: `is_reversal_run`.
2. **One vocabulary.** POS and payroll reasons live in
   `reversal_reason_codes` (`pos_wrong_item_scanned`, `pos_customer_cancelled`,
   `pos_tender_error`, `pos_training_transaction`, `payroll_wrong_period`,
   `payroll_incorrect_earnings`, `payroll_duplicate_run`,
   `payroll_wrong_employee_set`), and the shared generic codes now apply to both
   document types. `pos_void_reasons` remains the till-operational list and
   `src/services/pos/reversal/reasonCodes.ts` remains the per-command POS
   taxonomy with its accounting mapping (ADR 0012); both map INTO the governance
   vocabulary rather than forking it, and are the only documented exemptions to
   the reason-list ratchet.
3. **The gate is enforced at the row, not at the caller.**
   `_pos_transaction_reversal_gate` and `_payroll_run_reversal_gate` are
   `BEFORE UPDATE OF status` triggers that call `assert_can_reverse` on the
   terminal flip (`completed → voided`, `* → reversed`). Enforcing at the table
   means a new writer, an edge function or a backfill cannot bypass
   authorization, period locks or approval thresholds by forgetting a
   `PERFORM`.

## Consequences

- Reversal advice, blocked-reason text and approval policy are now identical in
  wording and behaviour across Sales, Purchases, Receiving, POS and Payroll.
- A POS void or payroll reversal above the organisation's approval threshold, or
  dated into a closed period, now fails loudly instead of proceeding.
- `src/test/architecture/reversal-intent-coverage.test.ts` is the ratchet: every
  entry in `REVERSIBLE_DOCUMENTS` must be a document type the intent authority
  understands, and no module may keep a private reason list.
- The finance body is reachable as `resolve_reversal_intent_finance`; new
  document types belong in a module resolver plus a dispatcher branch, never as
  another `ELSIF` chain in the finance body.
