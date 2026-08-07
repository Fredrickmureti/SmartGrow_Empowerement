---
name: Business reversal architecture
description: Reversal audit verdict, canonical posting/reversal writers, journal line scope invariant, paid-invoice policy, domain gaps
type: feature
---

## Canonical writers

Only three DB functions may insert journal lines (ADR 0123):
`post_journal_entry_atomic`, `update_journal_entry_atomic`,
`void_journal_entry_atomic`. `void_journal_entry_atomic` is the terminal
writer for EVERY reversal in the platform — invoice void (revenue and
COGS legs), payment void, bill and bill-payment void, goods-receipt
reversal, manual journal void, and payroll run reversal. A defect there
breaks reversal in every module at once.

Document-level reversal writers, one per document type:
`void_invoice_atomic` (ADR 0127), `void_payment_atomic` (ADR 0125),
`void_bill_atomic`, `void_bill_payment_atomic` (ADR 0126),
`void_goods_receipt_atomic` (ADR 0128). Warehouse and bank legs are
participants, never operator entry points: `wms_reverse_gr_stock`,
`wms_cancel_tasks_for_document`, `resolve_reversal_bank_block`.

`resolve_reversal_intent` is the single authority on which operation is
legal for a document; `preview_reversal_consequences` projects what it
would change. Any operation the intent matrix advertises MUST have a
writer — the `goods_return` gap (advertised for months, unimplemented)
is the failure mode to watch for.

## Journal line scope invariant

`journal_entry_lines.organization_id` and `business_id` are NOT NULL and
must equal the parent `journal_entries` row (`trg_jel_enforce_org_match`
validates, it does not backfill). Any writer inserting journal lines MUST
stamp `organization_id`, `business_id` and `branch_id` explicitly.
`default_je_line_context_from_parent` (BEFORE INSERT, runs first by name
order) backfills all three from the parent as a safety net — do not
remove that behaviour.

Regression coverage: `supabase/tests/journal_reversal_scope_test.sql`
(contract + behavioural, incl. paid-invoice void through revenue leg,
COGS leg and payment cascade).

## Orchestration shape

Posting is centralized; orchestration is per document type — one saga per
document (invoice, bill, payment, goods receipt, POS sale, payroll run,
stock document). That split is intentional and matches SAP/Oracle/NetSuite:
the saga owns sequence and compensation, participants own
accounting/stock/warehouse rules. Do not build a single god reversal engine.

Reversal never deletes: allocations, journal lines, movements and audit
rows are append-only. Compensation is offsetting rows plus status flips.
Goods-receipt reversal compensates with `return_out` movements under
`reference_type = 'goods_receipt_void'`, which doubles as its idempotency
probe.

## Paid-invoice policy (target)

Mature ERPs refuse to void a settled, reconciled or period-closed invoice
and force a credit note, refund or customer credit instead; none
cascade-unwind customer payments as a side effect of an invoice void.
Target state: `resolve_reversal_intent` decides the legal operation, and
`_cascade_payments` is retired as an operator-facing option.

## Known gaps (as of the 2026-08-07 audit)

- Bank reconciliation forward path: `useReconciliationItems.markAllReconciled`
  still writes `bank_transactions.is_reconciled` from the browser. Needs a
  canonical RPC before the bank ratchet in
  `src/test/architecture/reversal-writer-monopoly.test.ts` is widened past the
  release direction.
- Behavioural (pgTAP) coverage for the reversal RPCs is still thin — only
  architecture ratchets guard most of them.
- Governance: each reversal RPC re-implements its own authorization gate;
  there is no single reversal authorization policy.
- Payroll and POS reversal are not yet routed through
  `resolve_reversal_intent` / `preview_reversal_consequences`.

POS (`src/services/pos/reversal/*` + `pos_reversal_workflow_*`) is the
most mature surface and is the reference implementation other domains
converge toward — not a duplicate to remove.
