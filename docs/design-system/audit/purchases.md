# Purchases — Enterprise UX Audit

> **2026-07 follow-up.** The Bill row was marked Done after `BillRecordPage`
> was incorrectly mounted at `/purchases/bills/new`, while the list page still
> opened the legacy inline `<Dialog>` on "Add Bill". The list page now
> navigates to a dedicated `BillCreatePage` record form route (and the
> `?action=create` deep-link redirects there too).
> The guard test
> [`purchases-record-dialog-ban`](../../../src/test/architecture/purchases-record-dialog-ban.test.ts)
> gained a third assertion that scans list pages for inline `<Dialog>`
> record-create/edit blocks so this class of regression fails CI.


Companion to [`docs/design-system/records.md`](../records.md). Tracks every
create / edit / duplicate / convert / configure / peek surface in the
Purchases application against the enterprise UX standard.

Legend for **Target**:

- **Route + `RecordFormShell`** — full-page create/edit on a dedicated route
- **Route + `RecordScaffold`** — read-only object page
- **`PeekSheet` (`PeekScaffold`)** — one-record peek with `?peek=<id>` deep-link + "Open full page"
- **`DetailSheet`** — small (~≤6 fields, no line items) form sheet
- **`WizardShell`** — multi-step full-record workflow (convert / receive / reconcile / adjust)
- **`Dialog`** — confirmations, ≤6-field pickers, print preview, email send (allowed)

| Entity | Surface | Today | Target | Status |
| --- | --- | --- | --- | --- |
| Bill | Create | `/purchases/bills/new` → `BillRecordPage` | Route + `RecordFormShell` | Done |
| Bill | Edit | `/purchases/bills/:id/edit` → `BillEditPage` | Route + `RecordFormShell` | Done |
| Bill | View | `/purchases/bills/:id` → `BillRecordPage` | Route + `RecordScaffold` | Done |
| Bill | Peek (list) | `BillPeekSheet` behind `?peek=<id>` in `src/pages/Bills.tsx` | `PeekSheet` (`PeekScaffold`) | Done |
| Purchase Order | Create | `/purchases/orders/new` → `PurchaseOrderCreatePage` | Route + `RecordFormShell` | Done |
| Purchase Order | Edit | `/purchases/orders/:id/edit` → `PurchaseOrderEditPage` | Route + `RecordFormShell` | Done |
| Purchase Order | View | `/purchases/orders/:id` → `PurchaseOrderRecordPage` | Route + `RecordScaffold` | Done |
| Purchase Order | Peek (list) | `PurchaseOrderPeekSheet` behind `?peek=<id>` | `PeekSheet` (`PeekScaffold`) | Done |
| Goods Receipt | Receive from PO | `/purchases/goods-receipt/new` → `GoodsReceiptWizardPage` | `WizardShell` | Done |
| Goods Receipt | Peek (list) | (legacy `GoodsReceiptDetailDialog` deleted — no live consumers) | `PeekSheet` (`PeekScaffold`) | Done |
| Vendor Credit Note | Create | `/purchases/credit-notes/new` → `VendorCreditNoteCreatePage` | Route + `RecordFormShell` | Done |
| Vendor Credit Note | Edit | `/purchases/credit-notes/:id/edit` → `VendorCreditNoteEditPage` | Route + `RecordFormShell` | Done |
| Vendor Credit Note | View | `/purchases/credit-notes/:id` → `VendorCreditNoteRecordPage` | Route + `RecordScaffold` | Done |
| Vendor Credit Note | Peek (list) | `VendorCreditNotePeekSheet` behind `?peek=<id>` | `PeekSheet` (`PeekScaffold`) | Done |
| Vendor Credit Note | Apply to bill | `Dialog` (≤3 fields: bill / amount) | `Dialog` (allowed — confirm-style picker) | Done |
| Purchase Return | Create | `/purchases/returns/new` → `PurchaseReturnCreatePage` | Route + `RecordFormShell` | Done |
| Purchase Return | Edit | `/purchases/returns/:id/edit` → `PurchaseReturnEditPage` | Route + `RecordFormShell` | Done |
| Purchase Return | View | `/purchases/returns/:id` → `PurchaseReturnRecordPage` | Route + `RecordScaffold` | Done |
| Purchase Return | Peek (list) | `PurchaseReturnPeekSheet` behind `?peek=<id>` | `PeekSheet` (`PeekScaffold`) | Done |
| Purchase Return | Approve / Process / Cancel | row-menu action → toast | Stay as row-menu status actions | Done |
| Vendor Price List | Create / Edit | `VendorPriceListFormSheet` (`DetailSheet`) | `DetailSheet` (≤6 fields, no line items) | Done |
| Vendor Price List | Peek (list) | `VendorPriceListPeekSheet` (`DetailSheet`-based) at `src/features/purchases/price-lists/` | `PeekSheet` (`PeekScaffold` / `DetailSheet`) | Done |
| Expenses | Create | `/purchases/expenses/new` → `ExpenseCreatePage` | Route + `RecordFormShell` | Done |
| Expenses | Edit | `/purchases/expenses/:id/edit` → `ExpenseEditPage` | Route + `RecordFormShell` | Done |
| Expenses | Peek (list) | `ExpensePeekSheet` behind `?peek=<id>` in `src/pages/Expenses.tsx` | `PeekSheet` (`PeekScaffold`) | Done |
| Vendors (Contacts) | Create / Edit | reuses shared Contacts flow | Route + `RecordFormShell` at contacts level | Deferred (owned by Contacts) |
| Vendor Statements | View | `VendorStatementPeekSheet` behind `?peek=<id>` in `src/pages/VendorStatements.tsx` + `/purchases/statements/:id` → `VendorStatementRecordPage` | `PeekSheet` (`PeekScaffold`) + `RecordScaffold` object page | Done |
| RFQ | Create | `/purchases/rfqs/new` → `RFQCreatePage` | Route + `RecordFormShell` | Done |
| RFQ | Edit | `/purchases/rfqs/:id/edit` → `RFQEditPage` (draft only) | Route + `RecordFormShell` | Done |
| RFQ | View | `/purchases/rfqs/:id` → `RFQRecordPage` | Route + `RecordScaffold` | Done |
| RFQ | Peek (list) | `RFQPeekSheet` behind `?peek=<id>` in `src/pages/RFQs.tsx` | `PeekSheet` (`PeekScaffold`) | Done |
| RFQ | Convert to PO | side-rail action on `RFQRecordPage` calling `convert_rfq_to_po_atomic` RPC | Stay as confirm action | Done |
| Billing History | Peek | (legacy dialog file already removed — no live consumers) | `PeekSheet` (`PeekScaffold`) | Done |

## Enforcement

Every new file under `src/components/purchases`, `src/components/vendors`,
or `src/components/bills` matching either:

- `Create*Dialog.tsx` / `Edit*Dialog.tsx` — must be a `/new` or `/:id/edit`
  route on `RecordFormShell`, or
- `*DetailDialog.tsx` — must be a `*PeekSheet.tsx` on `PeekScaffold` /
  `DocumentPeekShell`,

is blocked by [`src/test/architecture/purchases-record-dialog-ban.test.ts`](../../../src/test/architecture/purchases-record-dialog-ban.test.ts).
Both allowlists are empty; they only shrink.

## Standard imports

Purchases modules import scaffolds from `@/design-system` only. Reaching
into `@/features/sales/record/*` from a Purchases file is a layering
violation — the scaffolds have been promoted (`PeekScaffold`,
`RecordScaffold`, `RecordBody`, `DocumentPeekShell`, `LineItemsGrid`,
`DocumentTotalsPanel`, `DocumentActivityPanel`, `usePeekParam`,
`useDocumentRecord`).
