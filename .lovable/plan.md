# Continuation plan — ERP UX Standardization

## Verified takeover state (latest audit)

| App | Pattern | Verified state |
|---|---|---|
| Purchases | Records + peeks | Guard allowlist empty; audit doc 32/33 Done, 1 deferred. **Complete.** |
| Sales phases 1–3 | Object routes for create/edit/view | Guard allowlist empty; scaffolds promoted to `@/design-system/records`. **Complete.** |
| Sales phases 4–5 | Wizards + configuration object pages | `RecordPaymentDialog.tsx` still present in `src/components/invoices/` and `src/components/sales/`. No routes for `receive-payment`, convert wizards, `apply-credit`, `refund`, `statements/new`, `customers/new`, `customers/merge`, `recurring/new`, `payments/new`, `/sales/configuration/*`. Guard does not catch these because they aren't named `Create*Dialog`. **Pending.** |
| Inventory drawers | `*PeekSheet` on `DetailSheet`/`PeekScaffold` | 4 legacy drawers migrated. `LEGACY_DIALOG_ALLOWLIST` empty. Done. |
| Inventory inline dialogs | Route + `RecordFormShell` / `DetailSheet` / `WizardShell` | Warehouse view + peek landed (`WarehouseView.tsx` on `/inventory-app/warehouses/:id` + `WarehousePeekSheet` on `?peek=<id>`); `Warehouses.tsx`, `Inventory.tsx`, `Transfers.tsx`, `ScrapRecording.tsx` removed from `LEGACY_INLINE_DIALOG_ALLOWLIST` (they no longer host any `<DialogTitle>` matching the guard). Only **`src/pages/Products.tsx`** still hosts an inline record dialog. Audit rows Pending: Physical Count create + commit, Reorder Rule create/edit + peek, Product create/edit + view, Product Category, Stock Lot peek, Stock Reservation peek. |
| Finance | Records / sheets / wizards | Audit 23 Pending / 1 Done. Allowlist holds 13 legacy dialogs + 1 permanent. No `src/features/finance/*`, no migrated routes. **Nothing implemented.** |

Routing: legacy `react-router-dom` SPA under TanStack `$.tsx` catch-all; sub-routes register in `src/apps/<app>/routes.tsx`.

## Just completed (this turn)

- Added `WarehousePeekSheet` (`src/components/warehouses/WarehousePeekSheet.tsx`) on `DetailSheet`.
- Added `WarehouseView` (`src/pages/inventory/WarehouseView.tsx`) on `RecordShell` + `RecordHeader` + `Section` + `FieldGrid`.
- Registered `warehouses/:id` route in `src/apps/inventory/routes.tsx`.
- Wired `?peek=<id>` handling + row-click in `src/pages/Warehouses.tsx` (dropdown cell stops propagation).
- Removed dead `Dialog*` imports from `Warehouses.tsx`.
- Shrunk `LEGACY_INLINE_DIALOG_ALLOWLIST` in `inventory-record-dialog-ban.test.ts` from 5 pages → 1 (`Products.tsx` only).
- Flipped the two Warehouse rows in `docs/design-system/audit/inventory.md` to Done.
- `tsgo --noEmit` clean; `bunx vitest run src/test/architecture/inventory-record-dialog-ban.test.ts` green (3/3).

## Remaining work (order)

### Slice A — Finish Inventory (continues)

1. **Products master** — biggest surface (~2000 LOC, ~41 dialog refs). Routes: `/inventory-app/products/{new,:id/edit,:id}` + `?peek=<id>`. `RecordFormShell` with Sections: Identity, Classification, Pricing, Inventory (base UoM, tracking, warehouses), Compliance, Identifiers/Barcodes, Packaging, Opening stock, Images. Preserve: category picker, image upload, tax/accounts, identifiers, packaging editor, opening stock handoff, scanner `createWithCode` onboarding, `?action=create`, `?createWithCode`, `?selected=` → peek/record. Remove inline `<Dialog>` from `Products.tsx`, then drop it from `LEGACY_INLINE_DIALOG_ALLOWLIST` (becomes `[]`).
2. **Product Category** → `DetailSheet` (≤6 fields) from Products taxonomy tab.
3. **Physical Count** → `WizardShell` at `/inventory-app/count/new` (scope → sheet → variance → commit) + `RecordScaffold` at `/:id`.
4. **Reorder Rule** → `DetailSheet` create/edit + `PeekScaffold`.
5. **Stock Lot** and **Stock Reservation** → `PeekScaffold` each.
6. Close-out: `LEGACY_INLINE_DIALOG_ALLOWLIST = []`; all remaining `**Pending**` rows in `docs/design-system/audit/inventory.md` → `Done` with concrete paths.

### Slice B — Sales phases 4 & 5

1. Record Payment wizard → `/sales/invoices/:id/receive-payment` on `WizardShell`. Delete both `RecordPaymentDialog.tsx` files; migrate call-sites to `navigate`.
2. Convert wizards → `/sales/estimates/:id/convert`, `/sales/orders/:id/convert`, `/sales/proforma/:id/convert`.
3. Refund wizard → `/sales/returns/:id/refund`.
4. Apply Credit wizard → `/sales/credit-notes/:id/apply`.
5. Generate Statement → `/sales/statements/new`.
6. Customer create + merge → `/sales/customers/new` (`RecordFormShell`), `/sales/customers/merge` (`WizardShell`).
7. Recurring create → `/sales/recurring/new`; Payments create → `/sales/payments/new`.
8. Sales configuration object pages on `RecordScaffold` under `/sales/configuration/*` (tax rules, numbering, terms, payment methods, customer groups).
9. Guard tightening: extend `sales-record-dialog-ban.test.ts` to also flag `RecordPayment*Dialog|Convert*Dialog|Apply*Dialog|Refund*Dialog|Statement*Dialog|Merge*Dialog`; add inline-dialog scan mirroring Inventory guard. Add Status column to `sales.md` audit doc.

### Slice C — Finance

Create `src/features/finance/*`. Register routes in `src/apps/finance/routes.tsx`.

- Records: Journal Entry (with `LineItemsGrid`), Business Transaction, Recurring Journal, Chart of Accounts entry, Budget, Fixed Asset, Bank Account.
- Sheets: Fiscal Period, Analytic Account.
- Wizards: Year-End Close, Bank Reconciliation (start + workspace + transfer-reconcile), Bank Transactions Import. Customer credit apply/refund live under Sales (Slice B) — delete finance duplicates.
- Delete `src/components/finance/CreditNoteDetailDialog.tsx`.
- Shrink `finance-record-dialog-ban.test.ts` allowlist to `[ApplyDefaultMappingsDialog.tsx]`.
- Flip every row in `docs/design-system/audit/finance.md` to Done.

## Technical notes

- New sub-routes register in `src/apps/<app>/routes.tsx` (not new TanStack file routes).
- Import scaffolds from `@/design-system` only.
- Tokens only — no hard-coded colors/spacing. Verify at 1280 / 1024 / 768 / 375.
- Data stays on `useSuspenseQuery` + `.functions.ts`; no RLS/schema changes.
- Extract shared record primitives that surface twice into `@/design-system/records`.
- Per-slice gate: targeted arch test → `tsgo --noEmit` → Playwright smoke.

## Definition of done

- All four `*-record-dialog-ban.test.ts` allowlists empty (except permanent confirm markers).
- Every row in `inventory.md`, `sales.md`, `finance.md` marked Done with a concrete route/component path.
- No `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` / `*DetailDrawer` / `Record*Dialog` / `Convert*Dialog` / `Apply*Dialog` / `Refund*Dialog` files remain under Sales, Inventory, Finance surfaces.
- `tsgo --noEmit` clean; architecture tests green; Playwright smokes pass per app.
- Every navigation entry point (menus, buttons, deep links, scanner handoffs, `?action=` params) points at the new route.
