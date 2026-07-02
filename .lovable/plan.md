
# ERP-Wide UX Standardization — Continuation Plan

## Verified state (independent audit, not agent notes)

**Sales — Phases 1–3 genuinely done.**
- 10/10 read-only object pages exist under `src/features/sales/*RecordPage.tsx`.
- 10/10 peek sheets exist (`*PeekSheet.tsx`); legacy `*DetailDialog` files deleted.
- All Create/Edit dialogs migrated to `/new` + `/:id/edit` routes on `RecordFormShell`. The `sales-record-dialog-ban` allowlist is empty and no `Create*Dialog`/`Edit*Dialog` files remain under `src/components/{invoices,estimates,sales,finance}`. ✅ verified in code.

**Sales — Phases 4–5 NOT started.**
- `RecordPaymentDialog` (both `components/invoices` and `components/sales` copies) is still a dialog. No `WizardShell` for Record Payment, Convert (estimate→invoice/SO), Apply credit, Refund return, Generate statement, Merge customers.
- `/sales/configuration/*` object pages (customer-groups, price-lists, invoice-templates, payment-terms, tax-defaults) do not exist.
- `ContactPreviewDrawer` for customers not yet moved onto the standard `DetailSheet`/`PeekScaffold`.

**Purchases — partially done.**
- Bills/POs/Vendor Credit Notes/Purchase Returns have `/new`, `/:id`, `/:id/edit` on `RecordShell`/`RecordFormShell`. ✅ verified.
- Still Pending per `docs/design-system/audit/purchases.md`:
  - Bill peek sheet (`BillDetailDialog` still in `src/pages/Bills.tsx`).
  - Expenses: create/edit as inline `Dialog` in `src/pages/Expenses.tsx`; `ExpenseDetailDialog` still present.
  - Vendor Statements: `VendorStatementDialog` — needs peek + `/purchases/statements/:vendor_id` record page.
  - RFQs: legacy dialog in `src/pages/RFQs.tsx` — needs `/new` + `/:id/edit` routes.
  - Billing History: `BillingHistoryDialog` — needs peek sheet.
  - `GoodsReceiptDetailDialog`, `VendorPriceListDetailDialog` also still exist as dialogs (not yet in audit ledger).
- No `purchases-record-dialog-ban` architecture test exists yet (audit doc references one but the file is absent).

**Inventory — untouched.** No audit doc, no `src/features/inventory/*`, no record pages. Every create/edit/adjust/transfer is still a dialog.

**Finance — untouched.** No audit doc, no `src/features/finance/*`. Journals, manual JEs, bank recs, chart-of-accounts, tax, budgets — all dialog-based.

## Design-system foundation (already shipped, reuse)

`@/design-system`: `RecordShell`, `RecordFormShell`, `RecordHeader`, `Section`, `FieldGrid`, `SummaryPanel`, `DetailSheet`, `FooterActionBar`, `WizardShell`, `useRecordFormSubmit`.

`@/features/sales/record`: `SalesRecordScaffold`, `SalesRecordBody`, `SalesPeekScaffold`, `DocumentPeekShell`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `usePeekParam`.

Extraction target: these Sales-record primitives are already domain-agnostic (Purchases imports them). During Finance work, promote them to `@/design-system/records/*` and delete the `@/features/sales/record` barrel (re-export shim only).

## Rollout order

Strict app-at-a-time, as the prompt requires: **Purchases → Sales Phases 4–5 → Inventory → Finance**. (Purchases first because it's the closest to closed and unblocks retiring the promoted primitives.)

### Phase P — Finish Purchases

1. Add `purchases-record-dialog-ban.test.ts` (twin of Sales guard) covering `src/components/{purchases,bills,vendors,expenses,rfqs}`. Seed allowlist with the currently-known dialogs; each migration below removes an entry.
2. **Bill peek**: replace `BillDetailDialog` mount in `src/pages/Bills.tsx` with `BillPeekSheet` (already exists) + `usePeekParam` + row-click `?peek=<id>`. Delete `BillDetailDialog`.
3. **Expenses**: create `ExpenseCreatePage` + `ExpenseEditPage` on `RecordFormShell` at `/purchases/expenses/new` and `/purchases/expenses/:id/edit`; `ExpensePeekSheet` on `PeekScaffold`. Retire inline dialog + `ExpenseDetailDialog`.
4. **RFQs**: `RfqCreatePage` + `RfqEditPage` on `RecordFormShell`; `RfqRecordPage` on `RecordShell`; `RfqPeekSheet`. Update `src/pages/RFQs.tsx` to navigate to routes.
5. **Vendor Statements**: `VendorStatementPeekSheet` + `/purchases/statements/:vendor_id` record page. Retire `VendorStatementDialog`.
6. **Billing History**: `BillingHistoryPeekSheet` replacing `BillingHistoryDialog`.
7. **Goods Receipt + Vendor Price List detail dialogs**: convert to peek sheets on `PeekScaffold`. `VendorPriceListFormSheet` (a `DetailSheet`, ≤6 fields, no line items) is compliant per the audit — keep.
8. Update `docs/design-system/audit/purchases.md` — flip every row to Done, add signed-off timestamp.

### Phase S4 — Sales wizards

Migrate the following dialog-driven multi-step flows to `WizardShell` on dedicated routes:

| Flow | Route | Current file |
|---|---|---|
| Record customer payment | `/sales/payments/new` (already an object page exists — replace create dialog with wizard) and `/sales/invoices/:id/receive-payment` | `RecordPaymentDialog` (2 copies) |
| Convert estimate | `/sales/estimates/:id/convert` | inline menu |
| Convert SO to invoice/delivery | `/sales/orders/:id/convert` | inline menu |
| Convert proforma → invoice | `/sales/proforma/:id/convert` | inline menu |
| Apply credit note | `/sales/credit-notes/:id/apply` | inline dialog |
| Process sales return refund | `/sales/returns/:id/refund` | inline dialog |
| Generate statement | `/sales/statements/new` | inline dialog |
| Merge customers | `/sales/customers/merge` | `ContactMergeDialog` |

Delete the two `RecordPaymentDialog.tsx` copies once callsites use the routes.

### Phase S5 — Sales configuration

New layout route `/sales/configuration` mirroring `/hr/configuration`. Sub-routes on `RecordShell`:

- `/sales/configuration/customer-groups`
- `/sales/configuration/price-lists`
- `/sales/configuration/invoice-templates`
- `/sales/configuration/payment-terms`
- `/sales/configuration/tax-defaults`

Retire `CustomerGroupsDialog`. Move `ContactPreviewDrawer` onto standard `DetailSheet`/`PeekScaffold`.

### Phase I — Inventory (full audit + migration)

1. Author `docs/design-system/audit/inventory.md` ledger — every create/edit/duplicate/adjust/transfer/receive/convert surface. Expected entities (verified against `src/pages` and `src/components/inventory`): Products, Product Variants, Categories, Warehouses, Locations, Bins, Stock Transfers, Stock Adjustments, Stock Counts, Reorder Rules, Serial/Lot tracking, Bundles/Kits, Units of Measure, Price Lists, Barcodes/Identifiers, Inventory Valuation, Reservations.
2. Land the `inventory-record-dialog-ban` guard with a seeded shrinking allowlist.
3. Ship record pages under `src/features/inventory/<entity>/*`: `*CreatePage`, `*EditPage`, `*RecordPage`, `*PeekSheet`, `use*Record` — using the promoted `@/design-system/records/*` primitives (see promotion step below).
4. Wizards for multi-step flows: Stock Transfer receive, Stock Adjustment approval, Physical Count, Reorder generation, Barcode enrollment.
5. Configuration hub `/inventory/configuration/*` for UoM, valuation methods, warehouses, adjustment reasons.

### Phase F — Finance (full audit + migration)

1. Author `docs/design-system/audit/finance.md` — expected entities: Chart of Accounts, Journal Entries, Manual Journals, Bank Accounts, Bank Reconciliation, Bank Rules, Cheques, Fixed Assets, Depreciation Runs, Tax Codes, Tax Returns, Budgets, Cost Centers, Financial Statements config, Period Close, Reporting Basis, Multi-currency, FX Revaluation.
2. `finance-record-dialog-ban` guard.
3. Ship record pages + peek sheets on `@/design-system/records/*`.
4. Wizards: Bank rec run, Period close, Depreciation run, Tax return filing, FX revaluation, Import bank statement.
5. Configuration hub `/finance/configuration/*`.

### Cross-cutting: promote shared record primitives

Between Phase P and Phase I, move `SalesRecordScaffold`, `SalesRecordBody`, `SalesPeekScaffold`, `DocumentPeekShell`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `usePeekParam`, `useSalesDocumentRecord` into `@/design-system/records/*` with domain-neutral names (`RecordScaffold`, `RecordBody`, `PeekScaffold`, `useDocumentRecord`). `@/features/sales/record` becomes a thin re-export shim to avoid a mass Sales rewrite; Purchases/Inventory/Finance import only from `@/design-system/records`. The purchases audit already anticipates this ("PeekScaffold, RecordScaffold, RecordBody promoted").

## Enforcement (guards that ship with the code, not just docs)

Every phase closes with:

- `<app>-record-dialog-ban.test.ts` — forbids new `Create*Dialog`/`Edit*Dialog`/`*DetailDialog` under that app's paths; shrinking allowlist for legacies.
- `<app>-record-shell-usage.test.ts` — every route under the app's `/new` / `/:id/edit` / `/:id` file matches a `RecordFormShell` / `RecordShell` import.
- Audit doc's ledger table has every row Done.
- `bun x tsgo --noEmit` clean; targeted vitest run for the new guards.

## Technical notes

- Route pattern: **TanStack Router** file-based routes for new record pages. Watch for the `_authenticated` layout gate — every record route must be nested under it, and loaders that touch the DB must go through `requireSupabaseAuth`. Server-fn modules ending in `.functions.ts` for data reads, `useServerFn` + `useSuspenseQuery` in components.
- Data plane: reuse existing hooks (`useInvoices`, `usePurchaseOrders`, `useBills`, …). Do NOT rewrite mutation logic during UX migration — the primitive change is the surface, not the business rules.
- Branch/business isolation: preserve every existing `currentBranch.id` stamping and RLS-aware read scoping (see `docs/audit/purchases-verdict.md`). No regressions.
- Tokens only: no hard-coded colors, spacing, or radii in the new components — everything through `src/styles.css` semantic tokens.
- Responsive: verify each new page at 1280 / 1024 / 768 / 375 as required by the audit checklist.

## What is explicitly OUT of scope

- Changing business logic, RLS policies, or database schemas beyond what a new record page trivially requires.
- Rewriting POS, HR/Payroll, CRM, Projects, Reports, Contacts (except customer/vendor scoped Sales/Purchases surfaces).
- Visual redesign of shared primitives — they already encode the standard.
- Payment provider, hardware, printing, or scanner architecture.

## Deliverables per app

1. Updated audit ledger (`docs/design-system/audit/<app>.md`) with every row marked Done and a dated sign-off block.
2. Every entity has: `*CreatePage`, `*EditPage`, `*RecordPage`, `*PeekSheet`, `use*Record` under `src/features/<app>/<entity>/`.
3. List page uses `?peek=<id>` + `usePeekParam`; row-click opens peek; "Open full page" jumps to `/:id`.
4. All legacy `Create*Dialog`/`Edit*Dialog`/`*DetailDialog` files under that app deleted.
5. Architecture guard tests green; empty allowlist.
6. `tsgo` clean.

## Order of execution

I will land these in the order above, one phase per turn where feasible, and post the audit ledger delta at the end of each phase so progress is auditable in-repo — not just in chat.
