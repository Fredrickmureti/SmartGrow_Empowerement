# Organization Data Reset — Architecture & Contract

_Last updated: 2026-04-18_

## What "reset" means here

Operational-data-only **hard wipe**, Xero/QBO "Go Live" semantics:

- **Wiped:** every transactional row scoped to the org (Sales, Purchases,
  Finance, Banking, POS, Inventory, Fixed-asset depreciation **postings**,
  Vendor credit notes, Purchase returns, the universal `transactions`
  projection, ancillaries, per-org sequences) **and** linked Storage
  files (expense receipts in `receipts`, generated PDFs in `document-pdfs`).
- **Preserved:** chart of accounts, contacts, products, tax codes,
  payment terms, organization settings, branches/businesses, users +
  roles, subscription, branding, automation rules, transaction
  categorization rules, **fixed_assets master**, **depreciation_schedules**
  (forecast/setup), **bank_accounts** (the link, not the txns).
- **Unlinked, not deleted:** `mpesa_c2b_transactions.matched_invoice_id`,
  `timesheets.invoice_id`, `depreciation_schedules.journal_entry_id`.

## Pipeline

```
OrgDataResetTool.tsx (3-step UI confirm + Preview button)
  └─ supabase.functions.invoke("clear-org-data", { mode, ... })
       ├─ mode="preview"    → rpc("preview_organization_reset")  [read-only]
       ├─ mode="wipe_all"   → rpc("list_org_storage_paths")
       │                       → rpc("reset_organization_data")  [atomic]
       │                       → storage.remove(receipts, document-pdfs)
       │                       → audit_logs insert
       └─ mode="categories" → rpc("reset_categories", [modules]) [atomic]
                              → audit_logs insert
```

## Modular RPC architecture

The wipe is split into per-module SECURITY DEFINER functions. The
master orchestrator just composes them in the right dependency order.

| Module RPC                                    | Wipes                                                                                       |
|-----------------------------------------------|---------------------------------------------------------------------------------------------|
| `reset_module__unlink_audit_refs(org)`        | NULLs `mpesa_c2b_transactions.matched_invoice_id`, `timesheets.invoice_id`                  |
| `reset_module__pos(org)`                      | All POS tables (txns/items/payments/modifiers, kitchen, split, held, gift, shifts, …)       |
| `reset_module__inventory(org)`                | Movement journal + adjustments (`stock_movements`, `stock_adjustments(+items)`, `stock_adjustment_backfill_log`, `stock_movements_orphans`); transfers (`stock_transfers(+items)`); receipts (`goods_receipts(+items)`, `backorders`, `replenishment_logs`); physical & cycle counting (`physical_counts(+lines,+events,+freeze_movements,+post_reconciliations,+tolerance_policies)`, `cycle_count_schedules`); balances/lots/reservations (`warehouse_stock`, `warehouse_stock_lots`, `stock_lots`, `lot_quarantine`, `stock_reservations`, `pos_stock_reservations`); costing (`cost_layers(+consumptions)`); traceability (`product_recalls(+items)`, `controlled_substance_register`, `prescriptions(+sale_links)`, `scan_events`); ops housekeeping (`scrap_attachments`, `reconciliation_sessions`) |
| `reset_module__fixed_assets(org)`             | `depreciation_entries`; unlinks `depreciation_schedules.journal_entry_id`                   |
| `reset_module__vendor_returns(org)`           | `purchase_returns(+items)`, `vendor_credit_note_applications`, `vendor_credit_notes`        |
| `reset_module__ancillaries(org)`              | `customer_statements`, `etims_transmission_logs`, `payment_requests`, scoped `approval_requests` |
| `reset_module__transactions_ledger(org)`      | `transactions` (universal projection — must run **before** Sales/AP)                        |
| `reset_module__banking(org)`                  | reconciliation items+sessions, `bank_transactions`, `bank_statements`                       |
| `reset_module__sales(org)`                    | AR subtree (payments, CN apps/items/CNs, SR items/SRs, DN items/DNs, invoice items/invoices, SO/Proforma/Est/Recurring) |
| `reset_module__purchases(org)`                | AP subtree (bill_payments, bill items/bills, PO items/POs, expenses)                        |
| `reset_module__finance(org)`                  | `journal_entry_lines` → `journal_entries` (runs **last**)                                   |
| `reset_module__sequences(org)`                | Resets `invoice_sequences`, `je_number_sequences`                                           |

## Master orchestrator: `reset_organization_data(org_id, token)`

- `SECURITY DEFINER`, `search_path = 'public'`.
- Permission: caller must be owner OR super_admin (`_assert_reset_permission`).
- Token: must equal `'RESET-' || org_id::text`.
- Atomic: single Postgres function call ⇒ implicit transaction.
- Calls every per-module RPC in this order:
  ```
  audit_unlinks → pos → inventory → fixed_assets → vendor_returns
  → ancillaries → transactions_ledger → banking
  → sales → purchases → finance → sequences
  ```
- Coverage check at the end re-counts every transactional table for
  `org_id`. Any residual > 0 raises and the whole transaction rolls back.
- Returns:
  ```json
  {
    "success": true,
    "totalDeleted": 12345,
    "details": { "<module>": { "<table>": <rows>, … }, … },
    "coverage_check": "passed"
  }
  ```

## Preview: `preview_organization_reset(org_id) → { preview, total }`

Read-only. Returns row counts that *would* be wiped per leaf table.
Used by the UI's “Preview What Will Be Wiped” button. Same permission
gate as the wipe itself.

## Categories mode: `reset_categories(org_id, categories text[])`

Transactional partial wipe. Accepts module names: `pos`, `inventory`,
`fixed_assets`, `vendor_returns`, `ancillaries`, `banking`,
`transactions_ledger`, `sales`, `purchases`, `finance`, `sequences`.
Audit unlinks always run first. If any module RAISEs (FK violation,
permission), the whole call rolls back — no half-wiped state.

## Storage cleanup

Two buckets are purged after the DB transaction commits, by the
`clear-org-data` edge function:

- `receipts` — paths collected from `expenses.receipt_url`.
- `document-pdfs` — paths collected from `documents.file_path`
  (org-scoped via `documents.organization_id`).

Path strings may be either bucket-relative (`uid/file.pdf`) or full
public/signed URLs — the edge fn parses both. Best-effort: storage
errors are logged but don't fail the response, because the DB wipe
(the source of truth) has already committed.

Other buckets are intentionally **not** purged here:
- `user-avatars`, `employee-avatars`, `organization-assets`,
  `product-images`, `signatures` → master data, preserved.
- `employee-documents`, `sign-documents`, `custom-field-attachments`
  → not part of the transactional wipe scope.

## Adding a new transactional table

1. Add the `DELETE` to the appropriate `reset_module__*` function in
   the right order (children before parents).
2. Add the table to the coverage-check `UNION ALL` in
   `reset_organization_data`.
3. Optionally add it to `preview_organization_reset` so the count
   shows up in the UI.

The coverage check is the safety net — it FAILS the wipe (rolling
back) the moment a new transactional table is forgotten.

## Permissions

- Edge function checks the JWT and permission once.
- Every RPC re-checks via `_assert_reset_permission(org_id)` —
  owner or super_admin only.
- Service role is **only** used for storage purge and audit logging,
  never for the DB wipe itself (that flows through the user JWT so
  `auth.uid()` resolves correctly).

## Test plan (recommended)

- **Coverage**: seed every transactional table, run wipe, assert counts
  zero for all, master tables untouched.
- **FK regression**: `SET CONSTRAINTS ALL IMMEDIATE` inside the test
  transaction.
- **Auth**: viewer/staff/admin can't run wipe; owner/super_admin can;
  bad token rejected (22023).
- **Idempotency**: run wipe twice — second call returns success with
  all counts 0.
- **Partial failure**: artificially fail one delete, assert tx rolls
  back fully (coverage check catches it).
- **Storage**: upload a receipt, run wipe, assert object removed.
- **Categories**: deleting `sales` only with bank_transactions still
  referencing JEs → friendly FK error, no partial delete.
- **Cross-org isolation**: seed two orgs, wipe one, assert other intact.
