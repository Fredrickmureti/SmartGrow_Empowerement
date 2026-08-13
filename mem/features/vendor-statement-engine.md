---
name: Vendor statement engine (AP)
description: Canonical AP statement architecture — ledger source, atomic upsert, durable send queue, download vs print disposition, template routing
type: feature
---

A Vendor Statement is a rendered projection of the AP subledger for one vendor
over one period. It is never re-derived from `bills` / `bill_payments`.

- **Source of truth**: `vendor_ledger_entries` folded by
  `src/services/finance/vendorStatementDataset.ts` (mirrored verbatim in
  `supabase/functions/_shared/reports/`). Aging comes from the GL-anchored
  `finance_ap_open_items` as of the period end, never `total - amount_paid`
  against the browser clock.
- **Bulk cohort**: `fetchPayableCounterparties` in
  `src/services/finance/openItems.ts` (open items net of
  `finance_ap_vendor_credit`). Never `bills.status`.
- **Persistence**: `upsert_vendor_statement_atomic(_payload jsonb)` is the only
  writer. Unique on (business, branch, contact, period_start, period_end), so
  re-running a period updates rather than duplicates. `vendor_statements`
  carries `branch_id`, `currency`, `document_record_id`, `finalized_at` —
  parity with `customer_statements`. It is NOT workspace-wide; scope it.
- **Delivery**: `enqueue_vendor_statement_send` → `vendor_statement_send_jobs`
  → drained by `flushVendorStatementSendOutbox` from
  `process-scheduled-automations`. Never a browser email loop.
- **Dispositions**: `downloadVendorStatement` (bytes to browser) and
  `dispatchVendorStatement` (print/output intent) in
  `src/features/purchases/statements/dispatchVendorStatement.ts` are the only
  exits. A download must never mint a print job.
- **Template routing**: statement kinds map to `template_type: "statement"` in
  `generate-document`'s `TEMPLATE_TYPE_MAP`; mapping them to `invoice` is what
  gave statements "Bill To" and an item table.

Guard: `src/test/architecture/vendor-statement-durability.test.ts`.
