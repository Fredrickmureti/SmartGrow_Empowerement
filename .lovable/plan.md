# Continuation plan — ERP UX standardization

## Verified takeover state

I re-checked the previous agent's claims against the codebase:

| Claim | Verified |
|---|---|
| Warehouse view + peek landed, Warehouses.tsx cleaned | ✅ `WarehouseView.tsx`, `WarehousePeekSheet.tsx` present |
| Inventory inline-dialog allowlist down to `Products.tsx` only | ✅ confirmed in `inventory-record-dialog-ban.test.ts` |
| Products master still hosts inline dialog (~2000 LOC, 41 Dialog refs) | ✅ confirmed |
| Purchases, Sales phases 1–3, Inventory drawers complete | ✅ per prior audit + guard state |
| Finance nothing implemented | ✅ `src/features/finance/` does not exist |
| Sales phases 4–5 pending (RecordPayment/Convert/Apply/Refund/Statements/Customers/Recurring/Configuration) | ✅ dialogs still present, no routes |

Previous plan is accurate and current. Continuing from where it stopped: **Inventory Slice A, item 1 (Products master)**.

## Working method

One slice at a time. Per slice: implement → `tsgo --noEmit` → targeted arch test → Playwright smoke → flip audit-doc rows to Done → shrink guard allowlist → move on. No cross-slice batching. No claims without a passing gate.

## Slice A — Finish Inventory

1. **Products master** — the largest remaining offender.
   - Routes on `src/apps/inventory/routes.tsx`: `/inventory-app/products/new`, `/:id/edit`, `/:id`, plus `?peek=<id>` on the list.
   - `RecordFormShell` with `Section` blocks: Identity, Classification, Pricing, Inventory (base UoM, tracking, warehouses), Compliance, Identifiers/Barcodes, Packaging, Opening stock, Images.
   - Preserve every existing capability: category picker, image upload, tax + accounts, identifiers, packaging editor, opening-stock handoff, scanner `createWithCode` onboarding, `?action=create`, `?createWithCode`, `?selected=` deep links.
   - Remove inline `<Dialog>` from `src/pages/Products.tsx`; drop it from `LEGACY_INLINE_DIALOG_ALLOWLIST` (set becomes empty).
2. **Product Category** → `DetailSheet` (≤6 fields) from Products taxonomy tab.
3. **Physical Count** → `WizardShell` at `/inventory-app/count/new` (scope → sheet → variance → commit) + `RecordScaffold` at `/:id`.
4. **Reorder Rule** → `DetailSheet` create/edit + `PeekScaffold`.
5. **Stock Lot** and **Stock Reservation** → `PeekScaffold` each.
6. Close-out: `LEGACY_INLINE_DIALOG_ALLOWLIST = []`; every Pending row in `docs/design-system/audit/inventory.md` → Done with a concrete route/component path.

## Slice B — Sales phases 4 & 5

1. Record Payment → `/sales/invoices/:id/receive-payment` on `WizardShell`. Delete both `RecordPaymentDialog.tsx` files (`src/components/invoices/`, `src/components/sales/`); migrate call-sites to `navigate`.
2. Convert wizards → `/sales/estimates/:id/convert`, `/sales/orders/:id/convert`, `/sales/proforma/:id/convert`.
3. Refund → `/sales/returns/:id/refund`.
4. Apply Credit → `/sales/credit-notes/:id/apply`.
5. Generate Statement → `/sales/statements/new`.
6. Customer create + merge → `/sales/customers/new` (`RecordFormShell`), `/sales/customers/merge` (`WizardShell`).
7. Recurring create → `/sales/recurring/new`; Payments create → `/sales/payments/new`.
8. Configuration object pages on `RecordScaffold` under `/sales/configuration/*` (tax rules, numbering, terms, payment methods, customer groups).
9. Extend `sales-record-dialog-ban.test.ts` to also flag `RecordPayment*Dialog|Convert*Dialog|Apply*Dialog|Refund*Dialog|Statement*Dialog|Merge*Dialog`; add an inline-dialog scan mirroring the Inventory guard; add a Status column to `docs/design-system/audit/sales.md`.

## Slice C — Finance

Create `src/features/finance/*` and register routes in `src/apps/finance/routes.tsx`.

- **Records (`RecordFormShell` + object page):** Journal Entry (with `LineItemsGrid`), Business Transaction (JE quick-post template), Recurring Journal, Chart of Accounts entry, Budget, Fixed Asset, Bank Account.
- **Sheets (`DetailSheet`):** Fiscal Period, Analytic Account.
- **Wizards (`WizardShell`):** Year-End Close, Bank Reconciliation (start + workspace + transfer-reconcile), Bank Transactions Import. Customer credit apply/refund live under Sales — delete the finance duplicates.
- Delete `src/components/finance/CreditNoteDetailDialog.tsx` (superseded by Sales `/sales/credit-notes/:id`).
- Shrink `finance-record-dialog-ban.test.ts` allowlist to `[ApplyDefaultMappingsDialog.tsx]` (permanent confirm-style).
- Flip every row in `docs/design-system/audit/finance.md` to Done.

## Technical notes

- New sub-routes register in `src/apps/<app>/routes.tsx`, not TanStack file routes.
- Import scaffolds from `@/design-system` only — never reach into `@/features/sales/record/*`.
- Design tokens only; no hard-coded colors, fonts, or spacing. Verify at 1280 / 1024 / 768 / 375.
- Data layer stays on `useSuspenseQuery` + `.functions.ts`; no RLS or schema changes required.
- Any record primitive that surfaces twice gets extracted to `@/design-system/records`.

## Definition of done

- All four `*-record-dialog-ban.test.ts` allowlists empty except permanent confirm-style markers.
- Every row in `docs/design-system/audit/{inventory,sales,finance}.md` marked Done with a concrete path.
- No `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` / `*DetailDrawer` / `Record*Dialog` / `Convert*Dialog` / `Apply*Dialog` / `Refund*Dialog` files remain under Sales, Inventory, or Finance surfaces.
- `tsgo --noEmit` clean; every architecture test green; per-app Playwright smoke passes.
- Every entry point (menus, buttons, deep links, scanner handoffs, `?action=` params) points at the new route.

## Starting point when approved

Slice A, item 1 — Products master. I'll scaffold the three routes + peek, port every section of the existing dialog into `RecordFormShell` Sections, migrate all deep-link entry points, remove the inline dialog, and empty the inventory guard allowlist before touching item 2.
