# Vendor Statements (AP) — audit findings and reconstruction

## What I verified before writing this

Read against the live database and the repo, not the UI:

- `vendor_statements` actual columns: `id, organization_id, business_id, contact_id, statement_date, period_start, period_end, opening_balance, total_billed, total_payments, closing_balance, sent_at, sent_to, pdf_url, created_by, created_at`. **There is no `branch_id` column.**
- `customer_statements` *does* have `branch_id`, and AR additionally has `customer_statement_send_jobs` (idempotency key, attempts, retry, last_error). AP has no equivalent.
- Policies on `vendor_statements` are permission-based (`user_has_module_permission(..., 'contacts', ...)`) and are not the cause of the failure.
- Financial truth is already canonical and shared: `vendor_ledger_entries` → `fetchVendorLedgerRows` → `buildVendorStatementDataset`, with aging from the GL-anchored `finance_ap_open_items` via `fetchContactOpenItemAging` as of period end. Screen, snapshot builder and the edge fetcher all use that same pair. This layer is sound and is not being rebuilt.

## Root cause of the 400 and the failed PDF (confirmed, not inferred)

Three call sites write or filter a column that does not exist on the table:

1. `useVendorStatements.ts` list query calls `applyBranchFilter(q, branchId)`, which emits `or=(branch_id.eq.X,branch_id.is.null)` → `GET /rest/v1/vendor_statements` **400**.
2. `saveStatement` inserts `branch_id` → the insert fails, so no statement id exists.
3. `purchasesVendorStatement.ts` selects `branch_id` in its header read, and the edge fetcher reads `stmt.branch_id`.

The "Failed to download statement PDF" toast is step 2 failing: the download path saves a statement first to obtain an id. So the fix is not the query — the schema drifted away from its AR twin, and the whole AP statement path was written against the AR shape.

Two further defects the symptom hides:

4. `generate-document/index.ts:3322` still maps `vendor_statement → "invoice"` template type. That is the invoice-shaped-statement defect the 2026-08-10 audit committed to removing; it was removed for the new renderer path but the legacy map still routes AP statements to a sales-invoice template ("Bill To", tax/line columns).
5. Bulk "Generate & Email All" loops in the browser, calling `send-document-email` per vendor with no idempotency key, no retry and no job row — AR's `customer_statement_send_jobs` is the canonical pattern and AP does not use it.

## What a Vendor Statement is in this system (settled, not re-litigated)

A **derived document with a frozen snapshot**. Financial truth stays in `vendor_ledger_entries` + `finance_ap_open_items`. `vendor_statements` is statement *metadata plus the identity of a rendered document* — period, statement date, currency, the totals as folded at generation time (for reconciliation, not as a second ledger), delivery state, and a link to the `document_records` snapshot that makes a sent statement reproducible byte-for-byte. It never becomes a competing balance engine.

## The work

### 1. Repair the schema drift (migration)
- Add `branch_id uuid` (FK `branches`, nullable, indexed) to `vendor_statements` — parity with `customer_statements`, so branch scoping is real rather than a query that 400s.
- Add `currency text` (ISO code, per project FX rule) stamped from the business base currency at generation, so a reprint cannot silently re-denominate.
- Add `document_record_id uuid` → `document_records(id)` so a statement points at the frozen snapshot that was actually sent, and `finalized_at timestamptz`.
- Unique index on `(organization_id, business_id, contact_id, period_start, period_end)` so repeated generation for the same period is idempotent instead of minting duplicates the download path then has to guess between.
- Grants unchanged (table already exposed); no policy change needed.

### 2. Retire the invoice template mapping for statements
Remove `vendor_statement`/`customer_statement`/`legal_recipient_statement` from the invoice `TEMPLATE_TYPE` map in `generate-document`, routing them to the statement profile. Extend `src/test/architecture/statement-pdf-routing.test.ts` so a statement kind can never resolve an invoice template profile again.

### 3. Give AP the same two dispositions as AR
`dispatchVendorStatement.ts` currently only has the print/output-intent exit. Add `downloadVendorStatement` + `vendorStatementFilename`, mirroring `dispatchCustomerStatement.ts`, and point the list action, peek sheet and record page at it. `VendorStatements.tsx` stops calling `downloadExport` with a raw document-type string.

### 4. Server-authoritative generation
Move generate-and-save out of the browser into a server function: it folds the ledger, stamps currency/branch/totals, upserts the statement on the idempotency key, and returns the id. The page stops composing accounting rows and then inserting them. Bulk generation becomes a loop over that one call.

### 5. AP send jobs
Add `vendor_statement_send_jobs` mirroring `customer_statement_send_jobs` (idempotency key, attempts, next_attempt_at, last_error, status) and route "Generate & Email All" through it. Email failure records a delivery failure; it never touches the statement's accounting fields.

### 6. Error handling
Replace the generic toast with cause-specific messages the failure actually supports: no posted AP activity in the period; snapshot/template unavailable; generated document missing; supplier has no email. Technical detail stays in the console, operational cause reaches the operator.

### 7. UI
Keep the workspace but make it read as an AP position, not a CRUD table: KPIs tied to real capability (suppliers with an open balance, statements generated this period, sent, delivery failures), period selector that visibly governs inclusion, and the row action set reduced to Preview / Download / Send with delivery state shown per row. Terminology audited: no "Bill To", no invoice/sales wording anywhere in the AP statement surfaces or template.

### 8. Tests
- Dataset: opening balance, bills, partial payments, multi-bill payment allocation, vendor credit note, reversal, closing balance = opening + charges − credits.
- Aging as of period end (not browser clock) agrees with `get_ap_aging_summary`.
- Reconciliation: statement closing balance = AP subledger balance for the same contact set and date.
- Idempotency: repeated generation and repeated download for one period produce one statement row and one document record.
- Architecture ratchets: no second AP aging or balance engine, no browser-side write of statement accounting fields, no statement kind resolving an invoice template, no read filtering a column the table lacks.

## Explicitly not doing

Not rebuilding the ledger/dataset/aging layer — it is already canonical and shared by every surface. Not introducing a second event system; statement events ride the existing outbox. Not adding a compatibility shim for the old browser-side save path — it is deleted.

## Technical notes

Column drift is the whole 400. Evidence: `information_schema.columns` for `vendor_statements` (no `branch_id`) vs `applyBranchFilter` in `src/lib/branchScope.ts`, the insert in `useVendorStatements.saveStatement`, and the header select in `src/services/documents/snapshots/purchasesVendorStatement.ts:219`. The stale `// SCOPE-EXEMPT: vendor_statements is workspace-wide (no business_id column)` comment in `VendorStatements.tsx` is also false — the table has `business_id` — and gets removed.
