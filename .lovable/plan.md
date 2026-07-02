## Assessment of prior work

I audited what the previous agent actually shipped versus what it claimed:

**Verified done**
- `src/design-system/` — `RecordShell`, `RecordFormShell`, `WizardShell`, `DetailSheet`, `SummaryPanel`, `FieldGrid`, `FooterActionBar`, `PeekScaffold`, `RecordScaffold`, `LineItemsGrid`, `DocumentPeekShell`, `useRecordFormSubmit`. Exported from `@/design-system`.
- **Sales Phases 1–3** — All 10 entities have object pages, peek sheets, and `/new` + `/:id/edit` routes on `RecordFormShell`. Guard `sales-record-dialog-ban.test.ts` allowlist is EMPTY.
- **Purchases** — Bills, POs, VCNs, Purchase Returns fully migrated (create + edit + record + peek). VPL peek exists. Guard `purchases-record-dialog-ban.test.ts` allowlist has 1 entry (`ExpenseDetailDialog.tsx`).

**Actually pending (verified via filesystem, not agent notes)**
- Purchases: Expenses (dialog-based create/edit in `src/pages/Expenses.tsx` (1535 lines) + `ExpenseDetailDialog.tsx`), RFQs (dialog in `src/pages/RFQs.tsx`), Vendor Statements peek + record page (`src/pages/purchases/VendorStatements.tsx`), Goods Receipt peek sheet (missing file — audit doc marked "Done" because legacy dialog had no consumers, but there's still no peek surface).
- Sales Phase 4 (Wizards): Record Payment, Convert (estimate/SO/proforma), Apply credit, Refund, Statement, Merge customers — none migrated to `WizardShell` routes.
- Sales Phase 5: `/sales/configuration/*` object pages — not started.
- **Inventory application** — no audit doc, no migration. Every create/edit/adjust/transfer surface still in legacy dialogs.
- **Finance application** — no audit doc, no migration.

The prior agent's "next turn" claim about closing out Purchases + moving to Sales 4–5 + Inventory + Finance is accurate as a to-do; none of it is actually done.

## Plan

Sequenced by the initiative's rule "complete one application before the next". Sales 4–5 finish Sales; then close Purchases; then Inventory; then Finance.

### Stage 1 — Close Sales (Phases 4 + 5)

1. **Wizards on `WizardShell`** (retire the remaining Sales dialogs):
   - `/sales/invoices/:id/receive-payment` — replaces `RecordPaymentDialog`
   - `/sales/estimates/:id/convert` — replaces convert menu
   - `/sales/orders/:id/convert`
   - `/sales/proforma/:id/convert`
   - `/sales/credit-notes/:id/apply`
   - `/sales/returns/:id/refund`
   - `/sales/statements/new` — replaces generate-statement dialog
   - `/sales/customers/merge` — replaces `ContactMergeDialog`
   Each is a 2–3 step wizard using `WizardShell` + `WizardStepper` + `useRecordFormSubmit`.

2. **Sales configuration** at `/sales/configuration/*`:
   `customer-groups`, `price-lists`, `invoice-templates`, `payment-terms`, `tax-defaults` — each an object page on `RecordShell` under a shared config layout (mirrors `/hr/configuration`).

3. Extend `sales-record-dialog-ban.test.ts` to also forbid `*Wizard*Dialog.tsx` and freeze a shrinking wizard-dialog allowlist.

### Stage 2 — Close Purchases

1. **Expenses**: build `ExpenseCreatePage` + `ExpenseEditPage` (`RecordFormShell`) at `/purchases/expenses/new` and `/purchases/expenses/:id/edit`, plus `ExpensePeekSheet` (`PeekScaffold`) at `?peek=`. Delete `ExpenseDetailDialog.tsx` and inline dialogs in `src/pages/Expenses.tsx`. Empty the guard allowlist.
2. **RFQs**: `RFQCreatePage`, `RFQEditPage`, `RFQRecordPage`, `RFQPeekSheet`. Retire the legacy dialog inside `src/pages/RFQs.tsx`. Add "Convert to PO" wizard at `/purchases/rfqs/:id/convert`.
3. **Vendor Statements**: `VendorStatementPeekSheet` on list + `/purchases/statements/:vendor_id` record page on `RecordScaffold`.
4. **Goods Receipt peek**: `GoodsReceiptPeekSheet` wired into the GR list (audit doc claimed done — I'll actually ship it).
5. Update `docs/design-system/audit/purchases.md` — all rows become Done.

### Stage 3 — Inventory application

1. Author `docs/design-system/audit/inventory.md` — comprehensive ledger of every entity: Products, Product Variants, Categories, Units of Measure, Warehouses, Bins, Stock Adjustments, Stock Transfers, Stock Counts / Cycle Counts, Reorder Rules, Serial/Lot tracking, Barcode enrollment, Landed Costs, Opening Stock, Inventory Valuation.
2. Build `inventory-record-dialog-ban.test.ts` guard with the audited legacy dialogs as the shrinking allowlist.
3. Migrate in order (biggest first): Products, Stock Adjustments, Stock Transfers, Stock Counts, Warehouses/Bins, Reorder Rules, Landed Costs, Opening Stock. Each entity gets: object page (`RecordScaffold`), peek sheet (`PeekScaffold`), create/edit routes (`RecordFormShell`), and — where needed — a wizard route (Adjust, Transfer, Count, Receive Opening Stock, Landed Cost apportionment).
4. Empty the guard allowlist as each entity lands.

### Stage 4 — Finance application

1. Author `docs/design-system/audit/finance.md` — Journal Entries, Chart of Accounts, Fiscal Periods, Reconciliation, Bank Feeds, Fixed Assets, Budgets, Tax Filings, Payment Batches, Manual Journals, Recurring Journals, Depreciation runs.
2. Build `finance-record-dialog-ban.test.ts` guard.
3. Migrate in the same object-page / peek / create-edit / wizard shape. Recon and depreciation are wizards; JE / COA / Fixed Assets are record pages.
4. Empty the guard allowlist.

### Cross-cutting (each stage)

- Reuse `@/design-system` primitives only — no new hand-rolled shells.
- Every create/edit route uses `useRecordFormSubmit` for the submit lifecycle.
- Every peek sheet uses `usePeekParam` + `PeekScaffold`.
- Wizards use `WizardShell` + `WizardStepper` on dedicated routes.
- After each stage: run `bunx vitest run src/test/architecture` + `tsgo` to confirm guards pass and typecheck is clean.
- Update the app's audit doc as the source of truth per stage; every row must end at **Done** before advancing.

### Technical notes

- `src/design-system/records/index.ts` currently re-exports `RecordScaffold`/`PeekScaffold` from `@/features/sales/record/*`. This is the documented promotion path — Purchases/Inventory/Finance already import via `@/design-system`. Physical relocation into `src/design-system/records/` is deferred to avoid churning Sales imports; it's a rename-only pass and can happen after Finance closes.
- Wizard routes belong under the entity's app segment (`/sales/...`, `/purchases/...`) — not under a global `/wizards` route — so browser back / breadcrumbs stay meaningful.
- Row-action menus on list tables stay for status transitions (approve, cancel, void, pause) — those are confirm-style and remain `Dialog`s per the enterprise standard.

I'll execute Stage 1 → 2 → 3 → 4 sequentially, verifying guard + typecheck between stages, updating each audit doc as the ledger of truth.