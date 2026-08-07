# Reversal & Compensation Architecture — Phase 5.4 + 5.5

Roadmap of record: `.lovable/plan/business-reversal-compensation-architecture-authoritative-st-2026-08-07.md`.

## Verification of the previous engineer's claims (done this turn, against the live database)

Confirmed real, not just documented:
- `assert_can_reverse`, `assert_reversal_reason`, `reversal_approval_requirement`, `request_reversal_approval`, `resolve_reversal_intent` all exist.
- All five canonical writers (`void_invoice_atomic`, `void_payment_atomic`, `void_bill_atomic`, `void_bill_payment_atomic`, `void_goods_receipt_atomic`) call the gate **and** the reason validator, and none of them still carries its own period check — the period check now lives only inside the gate.
- `assert_can_reverse` consults `reversal_approval_requirement`, so approval enforcement is inherited by every writer.
- `reversal_reason_codes` is seeded (21 codes); `reversal_approval_policies` exists with 2 RLS policies (0 rows configured yet, which is correct — no threshold means no gating).
- All five `reversal.*` action keys are registered in the governance registry.
- Client pieces exist and are wired: `ReversalReasonField`, `ReversalApprovalNotice`, `useReversalApproval` in the invoice, bill, bill-payment, goods-receipt and payment reversal surfaces.

Genuinely pending: Phase 5.4 (no `reversal_register` object exists anywhere in the database or code) and Phase 5.5.

One correction to the previous status: it treated POS and payroll as "siloed but fine for now". They are more divergent than noted — `pos_transactions` carries its own separate reversal vocabulary (`void_reason_id`, `void_override_id`, `reversal_type`) and `payroll_runs` carries `reversal_reason` free text with no code. Both are folded into the plan below.

## Phase 5.4 — Reversal audit register

**What the user gets:** one finance screen that answers "everything that was reversed in this period, why, by whom, for how much, and whether it was approved" — across sales, purchases, receiving, POS and payroll, instead of five separate module screens.

Work:
1. Migration creating `public.reversal_register` — a view unioning one branch per reversible document:
   - invoices, payments, bills, bill_payments, goods_receipts, pos_transactions, payroll_runs, customer_refunds.
   - Columns: `organization_id`, `business_id`, `module`, `document_type`, `document_id`, `document_number`, `document_date`, `reversal_date`, `amount`, `currency`, `reason_code`, `reason_comment`, `reversed_by`, `approval_request_id`, `reversal_kind` (void / reversal / return / correction).
   - Security-invoker view so existing per-table RLS applies unchanged; no new grants beyond `SELECT` to `authenticated`.
2. Finance surface: a "Reversal register" section reading the view through a server function, filterable by period, module, reason code and business, with amount totals per module. Reuses the existing finance page shell and table primitives — no new design language.
3. Guard test in `src/test/architecture/` asserting every module able to reverse contributes a branch to the view definition, so a new reversible document type cannot be added without appearing in the register.

## Phase 5.5 — POS and payroll parity

Bring the two divergent modules under the same canonical spine rather than leaving parallel vocabularies:
1. Map POS void/return/refund and payroll reversal onto `resolve_reversal_intent` document types, so legality answers come from one matrix.
2. Seed POS and payroll reason codes into `reversal_reason_codes`; have the POS void path and payroll reversal path validate through `assert_reversal_reason`, keeping the existing manager-override id as the approval linkage.
3. Route both through `assert_can_reverse` so period locks and approval thresholds apply identically.
4. Register `reversal.pos_transaction` and `reversal.payroll_run` action keys; extend `reversal_approval_policies` coverage to them.
5. Retire the module-local reason columns in favour of the shared `reason_code` (keep the old columns readable for history; stop writing them).

## Technical notes

- No new reversal engine, no new posting path: the writers, the posting monopoly (ADR 0123) and the approval engine stay as they are. 5.4 is read-only reporting; 5.5 is re-pointing two modules at existing gates.
- Every migration follows the create/grant/RLS/policy order; the view gets `SELECT` to `authenticated` only.
- Phases run in order and each ends with `tsgo --noEmit` plus the reversal policy SQL test suite green.
