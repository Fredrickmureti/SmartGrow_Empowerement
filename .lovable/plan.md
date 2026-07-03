# Continuation plan — ERP UX Standardization

## Verified takeover status

Independently re-checked file tree, guard tests, and audit docs:

- **Purchases** — complete. Both allowlists in `purchases-record-dialog-ban.test.ts` are empty; audit doc all Done.
- **Sales phases 1–3** — record/peek scaffolds promoted to `@/design-system/records` and re-exported from `@/features/sales/record` (verified in `src/design-system/index.ts` and `src/features/sales/record/index.ts`). Phases 4–5 (Record Payment, Convert, Apply Credit, Refund, Statement, Merge wizards; `/sales/configuration/*` object pages) still pending.
- **Inventory** — partially migrated:
  - Done: UoM/Packaging (`DetailSheet`), Warehouses (routed), Stock Transfers create (routed), Scrap create (routed), Stock Adjustment **create only** (`/inventory-app/adjustments/new`), Adjustment peek (`AdjustmentPeekSheet`), Barcode Enrollment (kept).
  - Legacy allowlist still holds 4 drawers: `MovementDetailDrawer`, `SourceDocumentDrawer`, `TransferDetailDrawer`, `WarehouseStockDrawer`.
  - Inline-dialog allowlist still holds 5 pages: `Products.tsx`, `Warehouses.tsx`, `Inventory.tsx`, `inventory/Transfers.tsx`, `inventory/ScrapRecording.tsx` — Products (~41 Dialog refs) and Inventory (~23) are the heaviest.
  - Missing: Product create/edit/view, Product Category, Stock Adjustment **edit**, Physical Count wizard, Reorder Rules, Stock Lot / Reservation peeks.
- **Finance** — audit file exists (`docs/design-system/audit/finance.md`, all 20 rows Pending), but no `src/features/finance/*`, no `finance-record-dialog-ban.test.ts`, no migrated routes. Nothing implemented.

Previous agent's last verified change: Stock Adjustment create route + deep-link forwarder. Everything past that is not yet done.

## Execution order

Finish one application at a time, guard test shrinks and audit doc flips to Done in the same slice.

### Slice A — Inventory (finish the app)

1. **Products master** (biggest surface). Add routes `/inventory-app/products/new`, `/:id/edit`, `/:id`, and `?peek=<id>` on the list. Build `ProductFormFields` shared by create + edit on `RecordFormShell` with `Section` + `FieldGrid` groups: Identity, Classification, Pricing, Inventory (base UoM, tracking, warehouses), Compliance, Identifiers/Barcodes, Packaging, Opening stock, Images. Preserve every integration: category picker, image upload, tax/accounts, identifiers, packaging editor, opening stock handoff, scanner `createWithCode` onboarding, `?action=create`, `?createWithCode`, `?selected=` → peek/record.
2. **Product Category** → `DetailSheet` (≤6 fields).
3. **Stock Adjustment edit** → `/inventory-app/adjustments/:id/edit` on `RecordFormShell` + `LineItemsGrid`, mirror create route's branch/warehouse scoping and GL preview; keep `ReverseAdjustmentDialog` as confirm dialog.
4. **Stock Transfer edit** and **Scrap edit** → `/:id/edit` routes on `RecordFormShell` (create routes already exist).
5. **Physical Count** → `WizardShell` at `/inventory-app/count/new` + `RecordScaffold` at `/:id`, preserving scanner counting and variance-apply.
6. **Drawers → PeekScaffold** (delete legacy files, shrink allowlist to `[]`):
   - `WarehouseStockDrawer` → `WarehouseStockPeekSheet`
   - `MovementDetailDrawer` → `StockMovementPeekSheet`
   - `SourceDocumentDrawer` → router push to owning-app peek (Bill/SO/Adjustment); PeekScaffold only where no owning peek exists
   - `TransferDetailDrawer` → `StockTransferPeekSheet`
7. **Reorder Rules** → `DetailSheet` create/edit + `PeekScaffold` view.
8. **Stock Lot / Reservation** → `PeekScaffold`.
9. Close-out: `LEGACY_DIALOG_ALLOWLIST` and `LEGACY_INLINE_DIALOG_ALLOWLIST` both empty; every audit row Done with the actual route/component path.

### Slice B — Sales phases 4 & 5

- `RecordPaymentDialog` (both copies) → `WizardShell` at `/sales/invoices/:id/record-payment`.
- `WizardShell` routes for Convert (quote→SO→invoice), Apply Credit, Refund, Generate Statement, Merge Customers.
- `/sales/configuration/*` object pages on `RecordScaffold` for tax rules, numbering, terms, payment methods.
- Add `sales-record-dialog-ban.test.ts` inline-dialog scan mirroring the Purchases guard.

### Slice C — Finance (audit → migration)

Migrate every row in `docs/design-system/audit/finance.md` to its target. Grouping:

- **Records (route + `RecordFormShell` + `PeekScaffold`)**: Journal Entry, Business Transaction quick-post, Recurring Journal, Chart of Accounts entry, Budget, Fixed Asset, Bank Account.
- **Sheets (`DetailSheet`)**: Fiscal Period, Analytic Account.
- **Wizards (`WizardShell`)**: Year-End Close, Bank Reconciliation start + workspace (with Bank Transfer Reconcile as a step), Bank Transactions Import, Customer Credit Apply, Customer Credit Refund.
- **Delete**: legacy finance `CreditNoteDetailDialog` (superseded by Sales credit-note record + peek).
- Add `finance-record-dialog-ban.test.ts` mirroring Purchases/Inventory guards; audit doc rows flip to Done as files land.

## Technical notes

- All new routes under the `_authenticated` TanStack file-based tree; keep the existing `/inventory-app/...`, `/sales/...`, `/finance/...` prefixes.
- Import scaffolds from `@/design-system` only (never `@/features/sales/record/*`).
- Tokens only — no hard-coded colors/spacing. Verify at 1280 / 1024 / 768 / 375.
- Data fetching stays on `useSuspenseQuery` + `.functions.ts`; no RLS or schema changes.
- Per-slice verification gate: targeted arch test → `tsgo --noEmit` → Playwright smoke on the migrated flow.

## Definition of done

- Both Inventory allowlists empty, both Purchases allowlists still empty, new Sales + Finance guards exist and are empty.
- Every audit row (`inventory.md`, `sales.md`, `finance.md`) marked Done with concrete route/component paths.
- No `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` / `*DetailDrawer` files remain under Inventory or Finance surfaces.
- `tsgo --noEmit` clean; architecture tests green; Playwright smokes pass on migrated Create/Edit/Peek per app.
