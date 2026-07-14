# Inventory — Enterprise UX Audit

> **Status: complete.** Every create / edit / peek / process surface in
> Inventory now routes through the design-system scaffolds
> (`RecordFormShell`, `WizardShell`, `DetailSheet`, `PeekScaffold`). The
> guard test scans both the `Create*Dialog` / `Edit*Dialog` /
> `*DetailDialog` filename patterns and inline `<Dialog>` record-form
> blocks on Inventory list pages; both allowlists are empty and only
> shrink.

Companion to [`docs/design-system/records.md`](../records.md). Tracks every
create / edit / duplicate / convert / configure / peek surface in the
Inventory application against the enterprise UX standard established by
the HR/Payroll and Sales/Purchases redesigns.

Legend for **Target**:

- **Route + `RecordFormShell`** — full-page create/edit on a dedicated route
- **Route + `RecordScaffold`** — read-only object page
- **`PeekScaffold`** — `?peek=<id>` deep-link peek + "Open full page"
- **`DetailSheet`** — small (~≤6 fields, no line items) form sheet
- **`WizardShell`** — multi-step workflow (physical count, transfer, adjustment approval)
- **`Dialog`** — confirmations, ≤6-field pickers (allowed)

| Entity | Surface | Today | Target | Status |
| --- | --- | --- | --- | --- |
| Warehouse | Create / Edit | Route + `RecordFormShell` at `src/pages/inventory/WarehouseForm.tsx` (`/inventory-app/warehouses/new` + `/:id/edit`) | Route + `RecordFormShell` | Done |
| Warehouse | View | Route + `RecordScaffold` at `src/pages/inventory/WarehouseView.tsx` (`/inventory-app/warehouses/:id`) + `WarehousePeekSheet` (`?peek=<id>`) | Route + `RecordScaffold` | Done |
| Warehouse Stock | Peek (list) | `WarehouseStockPeekSheet` on `DetailSheet` | `PeekScaffold` | Done |
| Stock Movement | Peek (list) | `StockMovementPeekSheet` on `DetailSheet` | `PeekScaffold` | Done |
| Stock Movement | Source doc peek | `SourceDocumentPeekSheet` on `DetailSheet` | `PeekScaffold` (delegate to source app peek) | Done |
| Stock Adjustment | Create | Route + `RecordFormShell` at `src/pages/inventory/AdjustmentNew.tsx` (`/inventory-app/adjustments/new`) | Route + `RecordFormShell` | Done |
| Stock Adjustment | Edit | N/A — posted adjustments are immutable (enterprise ERP standard: SAP/Oracle/D365/Odoo). Corrections flow through `ReverseAdjustmentDialog` + a fresh create. | Reverse-and-recreate (no edit route) | Done |
| Stock Adjustment | Peek (list) | `AdjustmentPeekSheet` at `src/components/inventory/AdjustmentPeekSheet.tsx` | `PeekScaffold` | Done |
| Stock Adjustment | Reverse | `ReverseAdjustmentDialog` | `Dialog` (allowed — confirm-style) | Done |
| Stock Transfer | Create | Route + `RecordFormShell` at `src/pages/inventory/TransferNew.tsx` (`/inventory-app/transfers/new`) | Route + `RecordFormShell` | Done |
| Stock Transfer | Edit | N/A — an in-transit or completed transfer is immutable; corrections use cancel/reverse + fresh create. | Cancel-and-recreate (no edit route) | Done |
| Stock Transfer | Peek (list) | `StockTransferPeekSheet` on `DetailSheet` | `PeekScaffold` | Done |
| Physical Count | Create session | `WizardShell` at `/inventory-app/physical-count` (Scope → Count → Review) | `WizardShell` | Done |
| Physical Count | View / commit | `WizardShell` review step posts via `apply_physical_count_atomic` RPC | `WizardShell` finalize step | Done |
| Scrap / Write-off | Create | Route + `RecordFormShell` at `src/pages/inventory/ScrapNew.tsx` (`/inventory-app/scrap/new`) | Route + `RecordFormShell` | Done |
| Scrap / Write-off | Edit | N/A — posted scrap is immutable; corrections use reverse + fresh create. | Reverse-and-recreate | Done |
| Reorder Rule | Create / Edit | Simple `reorder_level`/`reorder_quantity` fields live on `ProductForm` (routed `RecordFormShell`); advanced per-warehouse rules (`useProductReorderRules`) have no consumer surface — deferred until a rule authoring flow is requested. | `DetailSheet` (≤6 fields) | Done |
| Reorder Rule | Peek | Read-only reorder info surfaces via `ProductStockPanel` / `StockTab` on the product record; no standalone dialog exists to migrate. | `PeekScaffold` | Done |
| Product | Create / Edit | Route + `RecordFormShell` at `/inventory-app/products/new` + `/:id/edit` (`ProductForm.tsx`) | Route + `RecordFormShell` | Done |
| Product | View | `ProductDetailPanel` peek on shared `DetailSheet` primitive (migrated 2026-07-14 from raw `<Sheet>`; badges rendered in body to keep `SheetDescription` `<p>` valid; data hook split into critical + deferred phases) | Peek on `DetailSheet` | Done |
| Product Category | Create / Edit | `ProductCategoriesManager` on `DetailSheet` | `DetailSheet` | Done |
| UoM & Packaging | Create / Edit | `DetailSheet` in `src/pages/inventory/UomManagement.tsx` | `DetailSheet` | Done |
| Stock Lot | Peek | Lots surface via the `LotsExpiryTab` on the product record; no standalone lot dialog exists. | `PeekScaffold` | Done |
| Stock Reservation | Peek | Reservations surface via `ProductStockPanel` / `StockTab` on the product record; no standalone reservation dialog exists. | `PeekScaffold` | Done |
| Barcode Enrollment | Session | dedicated workspace at `/inventory/barcode-enrollment` | Keep — bespoke scan workspace, out of scope | Done |

## Enforcement

Every new file under `src/components/inventory`, `src/components/warehouses`,
or `src/components/products` matching either:

- `Create*Dialog.tsx` / `Edit*Dialog.tsx` — must be a `/new` or `/:id/edit`
  route on `RecordFormShell`, or
- `*DetailDialog.tsx` / `*DetailDrawer.tsx` — must be a `*PeekSheet.tsx` on
  `PeekScaffold`,

is blocked by [`src/test/architecture/inventory-record-dialog-ban.test.ts`](../../../src/test/architecture/inventory-record-dialog-ban.test.ts).
The allowlist is frozen against the six legacy drawers/dialogs listed
today and may only shrink.

## Standard imports

Inventory modules import scaffolds from `@/design-system` only. Never
reach into `@/features/sales/record/*` — the scaffolds have been
promoted to `@/design-system/records`.
