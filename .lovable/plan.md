# Enterprise Document Workspace — Verification Verdict & Remaining Phases

## Verification of the previous engineer's claims

I re-checked each "Done, verified" claim directly against the code, not the log.

| Claim | Verdict |
|---|---|
| Phase 1 descriptor (`DocumentRecordView`) | Confirmed — `src/design-system/records/types.ts`; `RecordScaffold` and `PeekScaffold` both project the same descriptor via `DocumentWorkspace.tsx`. |
| Phase 2 status + money registries | Confirmed — `documentStatus.tsx`, `money.ts`; no local status maps remain in Sales (ratchet test enforces it). |
| Phase 3 container-adaptive read grid | Confirmed — `LineItemsGrid` + `adaptiveColumns.ts`, no `min-w-[720px]` floor. |
| Phase 4 outliers migrated | Confirmed — `InvoiceRecordPage`, `EstimateRecordPage`, `SalesOrderRecordPage` are now ~30 lines each on the scaffold. |
| Phase 5 lifecycle + audit activity | Confirmed — `DocumentLifecycleStrip.tsx`, `useDocumentActivity.ts` (audit_logs + document_emails). |
| Phase 6 promotion to design system | Confirmed — layer lives in `src/design-system/records/`; only `useRecordPrint` remains under `features/sales/record` (correct — that is print, not layout). |
| Phase 7 ratchets | Confirmed — `document-workspace-canonical.test.ts`, 7 tests, passing. |
| Phase 8 (Invoice only) | Confirmed — `EditableLineItemsGrid` + `InvoiceLineRow` + `INVOICE_LINE_COLUMNS`; Invoice create/edit migrated, memo test passes. |

Also run: `tsgo --noEmit -p tsconfig.app.json` clean; ratchet + memo suites pass.
No inflated claims found. The log is accurate.

Confirmed still pending (verified by reading the files):
`EditableLineItemsGrid` has exactly two consumers — the Invoice create and
edit pages. Estimate, Sales Order, Credit Note, Delivery Note and Sales
Return forms still hand-roll `grid-cols-12` line editors with `sm:`-keyed
mobile card variants (the exact duplication Phase 8 exists to remove).

## Remaining work

### Phase 8 (finish) — migrate the last Sales line editors

One memoized row component + one `*_LINE_COLUMNS` contract per document,
mirroring `InvoiceLineRow`, then delete the bespoke grid/card markup:

1. Estimate — `EstimateCreatePage`, `EstimateEditPage` (edit still uses `<Table>`)
2. Sales Order — `SalesOrderCreatePage`, `SalesOrderEditPage` (`<Table>`)
3. Credit Note — `CreditNoteCreatePage`, `CreditNoteEditPage`
4. Delivery Note — `DeliveryNoteCreatePage` (qty/packaging/tracking columns)
5. Sales Return — `SalesReturnCreatePage` (return qty, reason, condition)

Rules applied to each: base quantity stays the stored value with packaging/UoM
provenance preserved; lot/serial pickers stay mounted where they exist today;
handlers wrapped in `useCallback` so the row memo engages; no `sm:`-keyed
duplicate mobile stack survives.

### Phase 8b — extend the ratchet

Extend `document-workspace-canonical.test.ts` so a Sales create/edit page
containing an inline `grid-cols-12` line editor or a `<Table>` of line items
fails CI. Without this, the next form regresses silently.

### Phase 9 — extend the layer beyond Sales

In order, module by module:
- Purchases: bill and purchase-order record surfaces onto the descriptor +
  scaffolds; bill/PO line editors onto `EditableLineItemsGrid`.
- Finance: payments and journal-entry record surfaces.
Each module ends with its bespoke shells deleted, not left alongside.

### Phase 10 — lifecycle completeness (new, from this review)

`DocumentLifecycleStrip` covers estimate → proforma → sales order → delivery
note → invoice. The parent prompt requires traversal through Payment →
Journal Entry → Reconciliation → Credit Note → Return → Collections. I will
verify what `get_document_lineage` returns today and extend the downstream
half so a controller can walk from an invoice to its posting and settlement.

## Verification at the end

- `tsgo --noEmit`, the canonical ratchet suite, memo tests.
- Playwright pass over each migrated form at drawer width and desktop width,
  screenshotting the line editor to confirm columns demote rather than scroll.
- Confirm no orphaned line-editor components remain in Sales.

## Technical notes

Shared API is `EditableLineItemsGrid` (`columns`, `rows`, `renderRow(row, i,
layout)`, `onAddRow`, `onRemoveRow`, `footer`, `toolbar`) with rows drawn
through `EditableLineRowCells`, sharing the measurement engine in
`adaptiveColumns.ts` with the read-only grid. No new dependencies.
