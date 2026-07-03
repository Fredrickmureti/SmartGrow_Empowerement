## Verified status

- **Purchases** — complete. All rows in `docs/design-system/audit/purchases.md` are Done; both allowlists in `purchases-record-dialog-ban.test.ts` are empty.
- **Inventory** — partially migrated by previous agents:
  - Done: UoM (`DetailSheet`), Barcode Enrollment (kept), Warehouses routed (`WarehouseNew`/`WarehouseEdit`/`WarehouseForm`), Stock Transfers routed (`TransferNew` + `?action=new` forwarder), Scrap routed (`ScrapNew`).
  - Still pending: Products, Stock Adjustments, Physical Count wizard, Reorder Rules, Product Categories, and every legacy `*Drawer.tsx` under `src/components/inventory/` (`WarehouseStockDrawer`, `MovementDetailDrawer`, `SourceDocumentDrawer`, `AdjustmentDetailDrawer`, `TransferDetailDrawer`).
  - `src/pages/Products.tsx` still contains 41 `Dialog` references and `src/pages/Inventory.tsx` 23 — the biggest remaining Inventory surfaces.
- **Sales phases 4–5** — not started (Record Payment / Convert / Apply credit / Refund / Statement / Merge wizards; `/sales/configuration/*` object pages).
- **Finance** — untouched; no audit file, no `src/features/finance/*`.

## Plan

### 1. Inventory — Products master (highest impact)

Route the product create/edit/view flow off the inline dialogs in `Products.tsx`:

- Add `/inventory-app/products/new`, `/inventory-app/products/:id/edit`, `/inventory-app/products/:id` (record page) plus `?peek=<id>` on the list.
- Build a shared `ProductFormFields` used by both create and edit on `RecordFormShell`, with `Section` + `FieldGrid` grouping: Identity, Classification (category / brand / tax), Pricing, Inventory (base UoM, tracking, warehouses), Compliance, Identifiers/Barcodes, Packaging, Opening stock, Images.
- Preserve every existing integration: category selection, image upload, tax fields, product accounts, identifiers, packaging editor, opening stock handoff, scanner `createWithCode` onboarding, `?action=create`, `?createWithCode`, and `?selected=` deep-link → peek/record.
- Migrate Product Category create/edit to `DetailSheet` (≤6 fields).
- List actions: Add → route; Edit → route; row click → peek (`?peek=<id>`) with "Open full page" jumping to the record route.

### 2. Inventory — Stock Adjustments

- Add `/inventory-app/adjustments/new` + `/:id/edit` on `RecordFormShell` with `LineItemsGrid`, preserving branch/warehouse scoping, reason → offset-account preview, GL posting, and the existing `ReverseAdjustmentDialog` (confirm-style, stays a dialog).
- Replace `AdjustmentDetailDrawer` with `AdjustmentPeekSheet` on `PeekScaffold` behind `?peek=<id>` on the Adjustments list.

### 3. Inventory — Physical Count wizard

- Convert the inline `PhysicalCount.tsx` workspace into a routed `WizardShell` at `/inventory-app/count/new` and a `RecordScaffold` at `/:id`, preserving scanner counting and variance-apply step.

### 4. Inventory — Drawers → PeekScaffold

Replace the remaining detail drawers with `*PeekSheet` on `PeekScaffold` behind `?peek=<id>`:

- `WarehouseStockDrawer` → `WarehouseStockPeekSheet` (list on `Warehouses.tsx` / `Inventory.tsx`)
- `MovementDetailDrawer` → `StockMovementPeekSheet`
- `SourceDocumentDrawer` → delegate to the owning app's peek (Bill / SO / Adjustment) via router push; peek sheet only when no owning app peek exists
- `TransferDetailDrawer` → `StockTransferPeekSheet`
- Delete the legacy `*Drawer.tsx` files and remove their allowlist entries in `inventory-record-dialog-ban.test.ts`.

### 5. Inventory — Reorder Rules

- Reorder Rule create/edit → `DetailSheet` (≤6 fields).
- Reorder Rule view → `PeekScaffold` behind `?peek=<id>`.

### 6. Inventory — guard + audit ledger

- Shrink `LEGACY_DIALOG_ALLOWLIST` and `LEGACY_INLINE_DIALOG_ALLOWLIST` in `inventory-record-dialog-ban.test.ts` to empty as each migration lands.
- Update `docs/design-system/audit/inventory.md` per-row to **Done** with the actual route / component path — no rows may be marked Done until the corresponding dialog file is deleted and the guard passes.

### 7. Sales — phases 4 & 5

- Convert `RecordPaymentDialog` (both copies) to a routed `WizardShell` at `/sales/invoices/:id/record-payment`.
- Add `WizardShell` routes for Convert (quote→SO→invoice), Apply Credit, Refund, Generate Statement, Merge Customers.
- Build `/sales/configuration/*` object pages on `RecordScaffold` for tax rules, numbering, terms, payment methods.
- Add `sales-record-dialog-ban.test.ts` inline-dialog scan (mirror of Purchases guard) to catch regressions.

### 8. Finance — full audit and migration

- Create `docs/design-system/audit/finance.md` (companion to the existing one referenced in code) enumerating every create/edit/convert/close surface: Journal Entry, Business Transaction (JE quick-post), Recurring Journal, Chart of Accounts entry, Fiscal Period, Year-End Close, Budget, Fixed Asset, Analytic Account, Bank Account, Bank Reconciliation, Bank Transfer Reconcile, Bank Transactions Import, Transaction Matching Rules, Customer Credit Apply / Refund, Default Account Mappings.
- Migrate each per its target column (routes for records with line items, `WizardShell` for close / reconcile / import, `DetailSheet` for small configs).
- Add `finance-record-dialog-ban.test.ts` mirroring the Purchases/Inventory guards.

### 9. Design-system promotion (do once, before Finance)

Promote the shared scaffolds still living under `@/features/sales/record` into `@/design-system/records/*` with domain-neutral names (`RecordScaffold`, `RecordBody`, `PeekScaffold`, `DocumentPeekShell`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `usePeekParam`, `useDocumentRecord`) and leave `@/features/sales/record` as a thin re-export shim. Finance and remaining Inventory work import from `@/design-system` only.

### Technical notes

- All new record routes go under the `_authenticated` layout in the TanStack file-based route tree; the router already exposes `/inventory-app/...` prefixes matching prior migrations.
- Data fetching stays on `useSuspenseQuery` + `.functions.ts`; no RLS or schema changes are in scope.
- All colors/spacing via tokens; verify at 1280 / 1024 / 768 / 375.
- Verification gate per slice: targeted architecture test → `tsgo` → Playwright smoke on the migrated flow.

### Order of execution

1. Inventory Products → Adjustments → Physical Count → Drawers → Reorder Rules → guard/audit close-out.
2. Design-system promotion.
3. Sales phases 4–5.
4. Finance audit + full migration.
