# Project Plan — Authoritative Status

Last updated: 2026-08-12

## Active wave: Expense & refund reversal parity — CLOSED

Full record: `.lovable/plan/handover-verification-verdict-reversal-wave-then-remaining-w-2026-08-12.md`

### Fully implemented and verified
- `preview_reversal_extras_expense` — analytic distributions, project cost entries, employee
  reimbursement payable, converted bill; error-severity warning while queued for payroll.
- `preview_reversal_extras_customer_refund` — bank cash-out leg + source receipt / credit note.
- `preview_reversal_consequences` dispatches to `preview_reversal_extras_<type>` and merges
  money lines, related documents and warnings. Core projection left generic.
- Both helpers internal: EXECUTE revoked from PUBLIC/anon/authenticated; reachable only via the
  SECURITY DEFINER wrapper and `service_role`.
- Expense void path: `Expenses.tsx` → `VoidExpenseDialog` → `expense_void(id, reason, reason_code)`
  with payroll-queue dequeue reported back. No bare `voidExpense(id)` call remains.
- `ReverseCustomerRefundSheet` reachable from refund rows of the customer ledger; resolves intent,
  renders enriched preview, refuses honestly and routes to the corrective customer receipt.
- ADR `docs/adr/0134-expense-and-refund-reversal-parity.md`.
- Guards in `src/test/architecture/reversal-intent-coverage.test.ts`: SQL-derived coverage,
  client entry point per reversible document type, preview-extras dispatch.
- Green: `reversal-intent-coverage` (6), `reversal-consequence-preview` (9),
  `ReversePayrollDialog` (8). Typecheck clean apart from pre-existing `useExpensesPaginated` TS2589.

### Pending
Nothing in this wave. No deferred items, no partial surfaces.

## Next milestone (new wave)
Governance coverage for reversals. `governance_action_registry` carries `reversal.*` keys for
invoice, payment, bill, bill_payment, expense and goods_receipt but none for
`vendor_credit_note`. Resolve whether that reversal is governed under another key or genuinely
has no approval requirement, then make the answer explicit — registry row plus an architecture
guard that every reversible document type maps to a governance decision (including an explicit
"no approval required" declaration), so the gap cannot recur silently.

## Instructions for the next agent
1. Verify before building. Re-run `bunx vitest run src/test/architecture` and confirm the three
   reversal guards pass; read ADR 0134 and spot-check that `preview_reversal_consequences` still
   dispatches to both extras helpers and that they remain revoked from `anon`/`authenticated`.
2. Only after verification, start the governance-coverage wave above. Do not pick unrelated work.
3. Keep the chronology: one wave brought to production-ready state before the next. Update this
   file immediately after each implementation.
