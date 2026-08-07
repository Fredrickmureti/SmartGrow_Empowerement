# Business Reversal & Compensation Architecture — Authoritative Status

Target: every business reversal in the ERP (Sales, Purchases, POS, Finance,
Inventory, Payroll) is explainable, deterministic, auditable and orchestrated by
ONE model: `resolve_reversal_intent` (legality) → `preview_reversal_consequences`
(projection) → one canonical atomic writer per operation → thin client wrapper.

Last updated: 2026-08-07 (verification pass by incoming engineer).
Active phase: **Phase 4 verified complete → Phase 5 (Governance) is next.**

## Phase 1 — verification of the previous engineer's claims

Checked directly against the live database and the codebase, not the notes.

Confirmed true:

- `void_journal_entry_atomic` stamps `organization_id` on reversal lines — the
  original void failure is genuinely fixed at the engine, not patched at the
  call site.
- Exactly one `resolve_reversal_intent` (no overload drift);
  `preview_reversal_consequences` + `_core` exist and `_core` derives from the
  intent authority.
- Canonical writers all exist: `void_invoice_atomic`, `void_payment_atomic`,
  `void_bill_atomic`, `void_bill_payment_atomic`, `void_goods_receipt_atomic`.
- Phase 4b real: `void_goods_receipt_atomic` calls both `wms_reverse_gr_stock`
  and `wms_cancel_tasks_for_document`.
- Phase 4c real: `void_bill_atomic` calls `po_resync_billed_state_for_bill`, and
  both resync functions exist. `bill_payments.status` exists (ADR 0126 shape).
- Client surfaces are thin wrappers: reversal RPC calls appear only in the
  dialogs, `useTransactionReversal`, `useBills` and the guard tests.
- SQL suites named in the log are present in `supabase/tests/`.

Confirmed still open (claims that were correctly reported as pending):

- No `assert_can_reverse` gate exists. Only `assert_can_reverse_payroll` does,
  and it is payroll-private.
- `void_bill_atomic`, `void_bill_payment_atomic`, `void_payment_atomic` do **not**
  reference `resolve_reversal_intent`; only the invoice and goods-receipt writers
  do. Legality is therefore non-uniform server-side.
- No reason taxonomy: `void_reason` / `reversal_reason` are free-text `text` on
  invoices, bills, bill_payments, journal_entries, payroll_runs,
  stock_adjustments, pos_transactions. The only typed one is
  `payment_reversal_events.reason_code` (`payment_reversal_reason` enum).
- Payroll and POS reversal remain outside intent/preview.
- Forward bank-reconciliation writes from the browser remain.

Not verifiable in this environment: the vitest guards and `tsgo` could not be
run (node_modules is not installed in the plan sandbox — `vitest` and
`@vitejs/plugin-react-swc` unresolved). Re-run them as the first build step.

## Phase 5 — Governance (this engagement's work)

Order is deliberate: legality first, then vocabulary, then approvals, then the
audit deliverable.

### 5.1 One authorization/legality gate

`assert_can_reverse(_document_type text, _document_id uuid, _operation text,
_actor uuid)` — `SECURITY DEFINER`, delegates to `resolve_reversal_intent`,
raises with the blocker code when the operation is not legal, and additionally
enforces actor permission (org/business membership + reversal capability).
Called as the **first statement** of all five canonical writers, replacing their
hand-rolled period/settlement/reconciliation checks. Writers keep their own
domain-specific invariants only where the intent matrix cannot express them.

Definition of done: a block in `supabase/tests/reversal_intent_policy_test.sql`
asserting each of the five writers' source contains the gate call, plus a
negative probe per writer (closed period, already reversed).

### 5.2 Unified reason taxonomy

New `public.reversal_reason_codes` catalog (code, label, applies_to document
types, requires_comment boolean, active) seeded with the AR/AP/GRN/POS/payroll
codes in use today. Writers validate `_reason` against it for their document
type; free-text becomes a mandatory *comment* alongside the code when
`requires_comment`. Existing free-text columns are preserved (append a
`reason_code` column, never rewrite history). Every reversal dialog swaps the
free-text field for a code select + comment box, sourced from one hook so the
vocabulary cannot fork per screen.

### 5.3 Approval thresholds

Route high-value and prior-period reversals through the existing approval
engine (no new approval implementation): a reversal policy row per organization
defining amount threshold and prior-period rule; `assert_can_reverse` returns
`requires_approval` and the dialog raises an approval request instead of
executing. Approval completion invokes the same canonical writer — one path.

### 5.4 Per-period reversal report

`reversal_register` view over the reversal event tables (payment/bill-payment
reversal events, voided documents, reversing journal entries) exposing period,
document, operation, reason code, actor, approver, compensating entry ids and
amounts. Surfaced as a Finance report page with period + document-type filters.
This is the auditability deliverable of the parent prompt.

### 5.5 ADR

`docs/adr/0129-reversal-authorization-policy.md` recording the gate, the reason
taxonomy, the approval rule and the register.

## Phase 6 — Payroll & POS convergence (after Phase 5)

Add `payroll_run` and `pos_transaction` branches to `resolve_reversal_intent`
and `preview_reversal_consequences_core`, delegating to the existing
`payroll_run_can_reverse` / `payroll_run_reversal_preview` and the POS workflow
functions. Render the shared `ReversalConsequencePreview` on both surfaces.
Fold `assert_can_reverse_payroll` into `assert_can_reverse`. No new engine, no
duplicated saga — POS stays the reference implementation.

## Phase 7 — Remaining debt (explicitly scheduled, not dropped)

1. Canonical RPC for forward bank reconciliation
   (`useReconciliationItems.markAllReconciled` writes `bank_transactions`
   directly), then widen the bank ratchet in `reversal-writer-monopoly.test.ts`
   past the release direction.
2. Business decision + implementation: retire `_cascade_payments` on
   `void_invoice_atomic` so a settled invoice must be resolved by credit note,
   refund or customer credit — matching SAP/Oracle/NetSuite behaviour. Requires
   `resolve_reversal_intent` to return the substitute operation and the invoice
   dialog to offer it.
3. Behavioural pgTAP coverage for `void_payment_atomic` and
   `void_bill_payment_atomic` (currently guarded only by architecture ratchets).

## Working rules for this engagement

- Verify before building; re-run the guards and `tsgo --noEmit` first.
- Finish each numbered step to production quality (writer + test/guard + dialog
  wiring) before starting the next.
- No second reversal engine, no fallback path, no legacy writer kept "just in
  case"; delete what the new path replaces.
- Update this file after each step: move items into a verified section and keep
  the active phase accurate.
