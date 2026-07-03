# Continuation plan — ERP UX Standardization

## Verified takeover state (audited against the codebase, not agent notes)

| App | Pattern | Verified state |
|---|---|---|
| Purchases | Records + peeks | Guard allowlist empty; audit doc 32/33 Done, 1 deferred (Vendor — owned by Contacts). **Complete.** |
| Sales phases 1–3 | Object routes for create/edit/view under `/sales/*/new`, `/:id/edit`, `/:id` | Legacy `Create*Dialog`/`Edit*Dialog` files gone; `sales-record-dialog-ban` allowlist empty; scaffolds live at `@/design-system/records` re-exported via `@/features/sales/record`. **Complete.** |
| Sales phases 4–5 | Wizards + configuration object pages | `RecordPaymentDialog.tsx` still present in `src/components/invoices/` and `src/components/sales/`. No routes for `receive-payment`, `estimates/:id/convert`, `orders/:id/convert`, `proforma/:id/convert`, `returns/:id/refund`, `credit-notes/:id/apply`, `statements/new`, `customers/new`, `customers/merge`, `recurring/new`, `/sales/configuration/*`. Guard doesn't catch these because they aren't named `Create*Dialog`. **Pending.** |
| Inventory drawers | `*PeekSheet` on `DetailSheet`/`PeekScaffold` | Previous agent's last change: 4 drawers (`Movement`, `SourceDocument`, `Transfer`, `WarehouseStock`) migrated. Legacy allowlist empty. Verified. |
| Inventory inline dialogs | Route + `RecordFormShell` / `DetailSheet` / `WizardShell` | Inline allowlist still holds 5 pages: `Products.tsx`, `Warehouses.tsx`, `Inventory.tsx`, `inventory/Transfers.tsx`, `inventory/ScrapRecording.tsx`. Audit doc has 11 rows Pending: Warehouse create/edit/view, Physical Count create + commit, Reorder Rule create/edit + peek, Product create/edit + view, Product Category, Stock Lot peek, Stock Reservation peek. **Pending.** |
| Finance | Records / sheets / wizards | Audit doc has 23 rows Pending / 1 Done. `finance-record-dialog-ban` allowlist holds 13 legacy dialogs (`ApplyCreditDialog`, `BusinessTransactionDialog`, `CreditNoteDetailDialog`, `ProcessRefundDialog`, `RecurringJournalDialog`, `YearEndClosingDialog`, plus 7 banking dialogs) plus 1 permanent (`ApplyDefaultMappingsDialog`). No `src/features/finance/*` folder, no migrated routes. **Nothing implemented.** |

Routing note: the app runs the legacy `react-router-dom` SPA under a TanStack `$.tsx` catch-all; sub-routes live inside `src/apps/<app>/routes.tsx`. All new create/edit/view/wizard/configuration routes register there, not as new TanStack file routes.

## Execution order

Finish one application at a time. Per slice: implement → shrink guard allowlist → flip audit rows → `tsgo --noEmit` + targeted arch test + Playwright smoke.

### Slice A — Finish Inventory

Register every new route in `src/apps/inventory/routes.tsx` (mirroring the existing `/inventory-app/adjustments/new` pattern).

1. **Products master** — biggest surface.
   - Routes: `/inventory-app/products/new`, `/:id/edit`, `/:id`, `?peek=<id>` on list.
   - Files: `src/features/inventory/products/{ProductCreatePage,ProductEditPage,ProductRecordPage,ProductPeekSheet,ProductFormFields,useProductRecord}.tsx`.
   - `RecordFormShell` with `Section` + `FieldGrid`: Identity, Classification, Pricing, Inventory (base UoM, tracking, warehouses), Compliance, Identifiers/Barcodes, Packaging, Opening stock, Images.
   - Preserve: category picker, image upload, tax/accounts, identifiers, packaging editor, opening stock handoff, scanner `createWithCode` onboarding, `?action=create`, `?createWithCode`, `?selected=` → peek/record.
   - Remove ~41 `Dialog` refs from `src/pages/Products.tsx`; page becomes list + `?peek=` peek only.
2. **Warehouses** — routes `/inventory-app/warehouses/new`, `/:id/edit`, `/:id`; delete inline dialog in `Products.tsx` warehouse tab; peek sheet on the list.
3. **Product Category** → `DetailSheet` (≤6 fields) triggered from Products taxonomy tab.
4. **Physical Count** → `WizardShell` at `/inventory-app/count/new` (steps: scope → sheet → variance → commit) + `RecordScaffold` at `/:id`; preserve scanner counting and variance-apply. Remove inline dialog in `src/pages/inventory/PhysicalCount.tsx`.
5. **Reorder Rule** → `DetailSheet` create/edit + `PeekScaffold` view.
6. **Stock Lot** and **Stock Reservation** → `PeekScaffold` each; delete inline dialogs.
7. **Close-out**
   - `LEGACY_INLINE_DIALOG_ALLOWLIST` in `inventory-record-dialog-ban.test.ts` → `[]`.
   - Every remaining `**Pending**` row in `docs/design-system/audit/inventory.md` → `Done` with concrete route/component path.
   - Remove now-unused imports and legacy dialog files.

### Slice B — Sales phases 4 & 5

Add wizard + configuration routes in `src/apps/sales/routes.tsx`.

1. **Record Payment** wizard → `/sales/invoices/:id/receive-payment` on `WizardShell` (amount/method/allocation → confirm). Delete `src/components/invoices/RecordPaymentDialog.tsx` and `src/components/sales/RecordPaymentDialog.tsx`; migrate all call-sites to `navigate({ to })`.
2. **Convert** wizards on `WizardShell`:
   - `/sales/estimates/:id/convert` (→ SO or Invoice)
   - `/sales/orders/:id/convert` (→ Delivery or Invoice)
   - `/sales/proforma/:id/convert` (→ Invoice)
3. **Refund** wizard → `/sales/returns/:id/refund`.
4. **Apply Credit** wizard → `/sales/credit-notes/:id/apply`.
5. **Generate Statement** wizard → `/sales/statements/new`.
6. **Customer create + merge**: `/sales/customers/new` (`RecordFormShell`), `/sales/customers/merge` (`WizardShell`).
7. **Recurring create** → `/sales/recurring/new` on `RecordFormShell`.
8. **Payments create** → `/sales/payments/new` on `RecordFormShell`.
9. **Sales configuration object pages** on `RecordScaffold`: tax rules, numbering, terms, payment methods, customer groups under `/sales/configuration/*`.
10. **Guard tightening**: extend `sales-record-dialog-ban.test.ts` to also flag `RecordPayment*Dialog|Convert*Dialog|Apply*Dialog|Refund*Dialog|Statement*Dialog|Merge*Dialog` filename patterns; add inline-dialog scan for the list pages mirroring the Inventory guard. Sales audit doc rows in `sales.md` gain a Status column populated as each route lands.

### Slice C — Finance (audit → migration)

Create `src/features/finance/*` mirroring `src/features/sales/*`. Register routes in `src/apps/finance/routes.tsx`.

- **Records** (route + `RecordFormShell` + `PeekScaffold`):
  - Journal Entry → `/finance/journal-entries/{new,:id/edit,:id}` with `LineItemsGrid`.
  - Business Transaction quick-post → `/finance/business-transactions/new`.
  - Recurring Journal → `/finance/recurring-journals/{new,:id/edit,:id}`.
  - Chart of Accounts entry → `/finance/accounts/{new,:id/edit,:id}`.
  - Budget → `/finance/budgets/{new,:id/edit,:id}`.
  - Fixed Asset → `/finance/fixed-assets/{new,:id/edit,:id}`.
  - Bank Account → `/finance/banking/accounts/{new,:id/edit,:id}` (replaces `ConnectBankDialog`, `EditBankAccountDialog`).
- **Sheets** (`DetailSheet`): Fiscal Period, Analytic Account.
- **Wizards** (`WizardShell`):
  - Year-End Close → `/finance/year-end-close`.
  - Bank Reconciliation → `/finance/banking/:accountId/reconcile` (start + workspace + transfer-reconcile as steps).
  - Bank Transactions Import → `/finance/banking/:accountId/import`.
  - Customer Credit Apply → routed under Sales (Slice B) — remove finance duplicate.
  - Customer Credit Refund → routed under Sales (Slice B) — remove finance duplicate.
- **Delete**: `src/components/finance/CreditNoteDetailDialog.tsx` (superseded by Sales credit-note record + peek).
- **Guard**: shrink `finance-record-dialog-ban.test.ts` allowlist to `[]` (keeping only `ApplyDefaultMappingsDialog` marker).
- Every row in `docs/design-system/audit/finance.md` → `Done` with concrete path.

## Technical notes

- All new routes register in the corresponding `src/apps/<app>/routes.tsx` — do not introduce new TanStack file routes for these sub-paths; the `$.tsx` catch-all + react-router SPA owns them.
- Import scaffolds from `@/design-system` only (never reach into `@/features/*/record/*` internals).
- Tokens only — no hard-coded colors/spacing. Verify at 1280 / 1024 / 768 / 375.
- Data stays on `useSuspenseQuery` + `.functions.ts`; no RLS or schema changes in this initiative.
- Extract shared record primitives that surface twice into `@/design-system/records` before duplicating (record header, action toolbar, footer bar, summary aside).
- Per-slice verification gate: targeted arch test (`bunx vitest run src/test/architecture/<app>-record-dialog-ban.test.ts`) → `tsgo --noEmit` → Playwright smoke on migrated Create/Edit/Peek/Wizard flow.

## Definition of done

- All four `*-record-dialog-ban.test.ts` allowlists empty (except permanent confirm-style markers).
- Every row in `inventory.md`, `sales.md`, `finance.md` marked Done with a concrete route/component path.
- No `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` / `*DetailDrawer` / `Record*Dialog` / `Convert*Dialog` / `Apply*Dialog` / `Refund*Dialog` files remain under Sales, Inventory, or Finance surfaces.
- `tsgo --noEmit` clean; architecture tests green; Playwright smokes pass per app.
- Every navigation entry point (menus, buttons, deep links, scanner handoffs, `?action=` params) points at the new route, not the deleted dialog.

## Order of execution

1. Slice A — Inventory: Products → Warehouses → Physical Count → Reorder → Lot/Reservation → Category → close-out.
2. Slice B — Sales phase 4 (wizards) → phase 5 (configuration) → guard tightening.
3. Slice C — Finance records → sheets → wizards → delete legacy → close-out.
