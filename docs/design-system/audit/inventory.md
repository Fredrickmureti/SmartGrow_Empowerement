# Inventory — Enterprise UX Audit

> **2026-07 takeover audit.** Inventory still has legacy inline record
> dialogs in Products, Warehouses, Stock Adjustments, Transfers, and Scrap.
> UoM category/unit configuration has moved to `DetailSheet`. The guard test
> now also scans list/workspace pages for inline record dialogs so no new
> Inventory regressions can be introduced while this allowlist shrinks through
> the route/sheet migration.

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
| Reorder Rule | Create / Edit | inline dialog | `DetailSheet` (≤6 fields) | **Pending** |
| Reorder Rule | Peek | inline dialog | `PeekScaffold` | **Pending** |
| Product | Create / Edit | inline dialog in `src/pages/Products.tsx` | Route + `RecordFormShell` at `/inventory/products/new` + `/:id/edit` | **Pending** |
| Product | View | inline dialog | Route + `RecordScaffold` at `/inventory/products/:id` | **Pending** |
| Product Category | Create / Edit | `ProductCategoriesManager` on `DetailSheet` | `DetailSheet` | Done |
| UoM & Packaging | Create / Edit | `DetailSheet` in `src/pages/inventory/UomManagement.tsx` | `DetailSheet` | Done |
| Stock Lot | Peek | inline dialog | `PeekScaffold` | **Pending** |
| Stock Reservation | Peek | inline dialog | `PeekScaffold` | **Pending** |
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
