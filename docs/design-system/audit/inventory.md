# Inventory — Enterprise UX Audit

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
| Warehouse | Create / Edit | inline dialog in `src/pages/Products.tsx` warehouse tab | Route + `RecordFormShell` at `/inventory/warehouses/new` + `/:id/edit` | **Pending** |
| Warehouse | View | inline expander | Route + `RecordScaffold` at `/inventory/warehouses/:id` | **Pending** |
| Warehouse Stock | Peek (list) | `WarehouseStockDrawer` | `PeekScaffold` | **Pending** |
| Stock Movement | Peek (list) | `MovementDetailDrawer` | `PeekScaffold` | **Pending** |
| Stock Movement | Source doc peek | `SourceDocumentDrawer` | `PeekScaffold` (delegate to source app peek) | **Pending** |
| Stock Adjustment | Create / Edit | inline dialog | Route + `RecordFormShell` at `/inventory/adjustments/new` + `/:id/edit` | **Pending** |
| Stock Adjustment | Peek (list) | `AdjustmentDetailDrawer` | `PeekScaffold` | **Pending** |
| Stock Adjustment | Reverse | `ReverseAdjustmentDialog` | `Dialog` (allowed — confirm-style) | Done |
| Stock Transfer | Create / Edit | inline dialog in `src/pages/inventory/Transfers.tsx` | Route + `RecordFormShell` at `/inventory/transfers/new` + `/:id/edit` | **Pending** |
| Stock Transfer | Peek (list) | `TransferDetailDrawer` | `PeekScaffold` | **Pending** |
| Physical Count | Create session | inline dialog in `src/pages/inventory/PhysicalCount.tsx` | `WizardShell` at `/inventory/physical-count/new` | **Pending** |
| Physical Count | View / commit | inline dialog | Route + `RecordScaffold` + `WizardShell` finalize step | **Pending** |
| Scrap / Write-off | Create | inline dialog in `src/pages/inventory/ScrapRecording.tsx` | Route + `RecordFormShell` at `/inventory/scrap/new` | **Pending** |
| Reorder Rule | Create / Edit | inline dialog | `DetailSheet` (≤6 fields) | **Pending** |
| Reorder Rule | Peek | inline dialog | `PeekScaffold` | **Pending** |
| Product | Create / Edit | inline dialog in `src/pages/Products.tsx` | Route + `RecordFormShell` at `/inventory/products/new` + `/:id/edit` | **Pending** |
| Product | View | inline dialog | Route + `RecordScaffold` at `/inventory/products/:id` | **Pending** |
| Product Category | Create / Edit | inline dialog | `DetailSheet` | **Pending** |
| UoM & Packaging | Create / Edit | inline dialog in `src/pages/inventory/UomManagement.tsx` | `DetailSheet` | **Pending** |
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
