# Reversal & Compensation Architecture — Authoritative Status

Roadmap of record: `.lovable/plan/business-reversal-compensation-architecture-authoritative-st-2026-08-07.md`.
This file tracks live status only. Phases are executed in order; no phase is left partial.

## Currently active

**Phase 5.4 — Reversal audit register** (next to start).

## Completed and verified

### Phase 5.1 — Unified authorization gate (done)
- `public.assert_can_reverse(document_type, document_id, operation, reason, effective_date)` is the single legality gate. It delegates the legality matrix to `resolve_reversal_intent`, checks the requested operation is offered, and enforces the effective-date period check via `is_period_open`.
- Called immediately after row lock by all five canonical writers: `void_invoice_atomic`, `void_payment_atomic`, `void_bill_atomic`, `void_bill_payment_atomic`, `void_goods_receipt_atomic`.
- Hand-rolled `is_period_open` / `user_belongs_to_org` checks removed from those writers.
- Verified: `supabase/tests/reversal_intent_policy_test.sql` blocks 1–11 (writers call the gate, no duplicated legality, behavioural refusal probes).

### Phase 5.2 — Reason taxonomy (done)
- `public.reversal_reason_codes` catalog (seeded AR/AP/GRN/payroll codes, `applies_to[]`, `requires_comment`).
- `reason_code` columns on `invoices`, `payments`, `bills`, `bill_payments`, `goods_receipts`.
- `public.assert_reversal_reason` validates the code against the document type and enforces mandatory comments; all five writers take and validate `_reason_code`.
- Client: `useReversalReasonCodes` + `ReversalReasonField`, wired into the invoice, bill, bill-payment, goods-receipt and payment reversal surfaces. Confirm buttons stay disabled until the reason is complete.

### Phase 5.3 — Approval thresholds (done)
- `public.reversal_approval_policies` — per organization (optionally per business) money threshold per document type plus a prior-period-always-approve flag. RLS: organization members only.
- Reversal actions registered in `governance_action_registry` (`reversal.invoice`, `.payment`, `.bill`, `.bill_payment`, `.goods_receipt`, `subject_mode = from_entity`).
- `public.reversal_approval_requirement(document_type, document_id, operation, effective_date)` returns `{ required, satisfied, reasons[], amount, amount_threshold, action_key, request_id, request_status }`.
- `public.request_reversal_approval(...)` validates the reason code and routes through the existing `approval_route` engine — no parallel approval mechanism.
- `assert_can_reverse` now refuses any gated reversal until approval is granted, so every writer inherits enforcement.
- Client: `useReversalApproval` + `ReversalApprovalNotice`, rendered in `VoidInvoiceDialog`, `VoidBillDialog`, `ReverseGoodsReceiptDialog`, `BillPaymentHistoryDialog` and `ReversePaymentWizard`. Confirm is blocked while approval is required and unsatisfied.
- Verified: `tsgo --noEmit` clean; `supabase/tests/reversal_intent_policy_test.sql` blocks 12–14 (policy table + RLS, resolver/request functions exist, gate consults the resolver, all action keys registered) checked against the live schema.

## Pending

### Phase 5.4 — Reversal audit register (next)
- `public.reversal_register` view unioning reversals across sales, purchases, receiving, POS and payroll with: document type, document number, original + reversal date, amount, reason code, reason comment, actor, approval request id.
- Period-scoped reporting surface (finance page/section) reading that view, filterable by period, module and reason code.
- Guard test asserting every module that can reverse contributes a branch to the register.

### Phase 5.5 — Module parity (after 5.4)
- Bring POS void/return and payroll correction reversals under `resolve_reversal_intent` + `assert_can_reverse` + reason taxonomy, so they stop being siloed.

## Instructions for the next agent

1. **Verify before you extend.** Re-run `supabase/tests/reversal_intent_policy_test.sql` checks and `tsgo --noEmit`. Confirm on the live schema that: `assert_can_reverse` still references `reversal_approval_requirement`; the five writers still call the gate and contain no local legality checks; `reversal_approval_policies` has RLS with organization-scoped policies; the five `reversal.*` action keys are registered. Fix any drift before writing new code.
2. **Then resume at Phase 5.4** — the reversal audit register — not unrelated work.
3. Keep the invariant: legality lives in `resolve_reversal_intent`, enforcement in `assert_can_reverse`, vocabulary in `reversal_reason_codes`, approval in the existing approval engine. Never fork any of these into a screen or a writer.
