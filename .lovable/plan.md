## Independent verification of prior work

I re-checked the codebase against the previous agent's claims and the existing plan at `.lovable/plan.md`:

- **Sales** — allowlist empty, all 10 entities on `RecordFormShell` / `RecordScaffold` / `PeekScaffold`. **Done.**
- **Purchases** — Bills, POs, Goods Receipts, Vendor Credit Notes, Purchase Returns, Vendor Price Lists all migrated. **P.1 Expenses verified done**: `ExpenseCreatePage` + `ExpenseEditPage` exist under `src/features/purchases/expenses/`, wired in `src/apps/purchases/routes.tsx`, ledger row flipped to Done. Purchases guard allowlist is empty.
- **Remaining Purchases**: Vendor Statements (still inline peek dialog in `src/pages/VendorStatements.tsx`) and RFQs (inline create/edit dialog in `src/pages/RFQs.tsx`).
- **Inventory** — untouched: 5 legacy drawers, every create/edit is an inline dialog.
- **Finance** — untouched: 13 legacy dialogs pending, 1 permanent confirm-style.

The existing plan is sound and matches the codebase reality. I will continue from P.2 without re-doing P.1.

## Phase P — Purchases tail (finish the app)

**P.2 Vendor Statements**
- `VendorStatementPeekSheet` on `PeekScaffold` behind `?peek=<vendorId>` in `src/pages/VendorStatements.tsx`.
- `/purchases/statements/:vendor_id` record page on `RecordScaffold` (reuse the shared statement body between peek and full page).
- Delete inline peek dialog.

**P.3 RFQs**
- `RFQCreatePage`, `RFQEditPage`, `RFQRecordPage`, `RFQPeekSheet` — full 4-surface set at `/purchases/rfqs/{new,:id/edit,:id}` + `?peek=<id>`. `RecordFormShell` + `useRecordFormSubmit` with line-items grid.
- Retire inline dialog in `src/pages/RFQs.tsx`; navigate() from list actions.

**P.4 Purchases close-out**
- Flip Vendor Statements + RFQs rows to `Done` in `docs/design-system/audit/purchases.md`.
- Extend `purchases-record-dialog-ban.test.ts` with an inline-JSX grep assertion against `src/pages/Expenses.tsx`, `src/pages/RFQs.tsx`, `src/pages/VendorStatements.tsx` to prevent regressions.
- `tsgo` + guard test green.

## Phase I — Inventory (full app)

Order: retire drawers/peek surfaces first (allowlist to 0), then create/edit routes, then wizards. Each entity gets the standard 4 surfaces unless noted.

**I.1 Peek + read-only object pages (retires 5 legacy drawers)**
- Warehouse Stock → `WarehouseStockPeekSheet`, delete `WarehouseStockDrawer`.
- Stock Movement → `StockMovementPeekSheet`, delete `MovementDetailDrawer`.
- Stock Movement source doc → delegate to source app peek (Sales/Purchases already have peek routes), delete `SourceDocumentDrawer`.
- Stock Adjustment → `AdjustmentPeekSheet` + `/inventory/adjustments/:id` record page, delete `AdjustmentDetailDrawer`.
- Stock Transfer → `TransferPeekSheet` + `/inventory/transfers/:id`, delete `TransferDetailDrawer`.

**I.2 Create/edit routes on `RecordFormShell`**
- Warehouse (`/inventory/warehouses/{new,:id/edit,:id}`).
- Stock Adjustment (line-item grid; cost-required rule enforced client-side per core mem).
- Stock Transfer (line-item grid, from/to warehouse fields).
- Scrap / Write-off (`/inventory/scrap/new`).
- Product + Product Category (`/inventory/products/{new,:id/edit,:id}`; category as `DetailSheet`).
- Reorder Rule → `DetailSheet` per target.
- UoM & Packaging → `DetailSheet`.

**I.3 Wizards**
- Physical Count → `/inventory/physical-count/new` on `WizardShell` (scope → counting → variance review → commit). `/inventory/physical-count/:id` on `RecordScaffold`.

**I.4 Peek-only entities** (`PeekScaffold`, no /new)
- Stock Lot, Stock Reservation, Reorder Rule peek.

**I.5 Close-out**
- Every ledger row → `Done` in `docs/design-system/audit/inventory.md`.
- Empty the `inventory-record-dialog-ban.test.ts` allowlist.
- Add inline-dialog grep assertion for `src/pages/Products.tsx`, `src/pages/inventory/*.tsx`.

## Phase F — Finance (full app)

Order: read-only + peek surfaces first so object-page destinations exist before create/edit routes are wired.

**F.1 Journal Entry family**
- `/finance/journal-entries/:id` (`RecordScaffold`) + `?peek=<id>` (`PeekScaffold`) with debit/credit `LineItemsGrid`.
- `/finance/journal-entries/new` + `/:id/edit` on `RecordFormShell` with balanced-entry validation client-side + DB constraint.
- `BusinessTransactionDialog` → same `/new?template=business` route with a template selector step; delete the dialog.
- `RecurringJournalDialog` → `/finance/recurring-journals/{new,:id/edit,:id}` + `?peek=<id>` on `RecordFormShell` / `RecordScaffold`; delete the dialog.

**F.2 Chart of Accounts + Fiscal**
- `/finance/accounts/{new,:id/edit}` on `RecordFormShell`.
- Fiscal Period → `DetailSheet` (≤6 fields).
- Year-End Close → `/finance/fiscal-periods/close` `WizardShell` (period selection → validation → post → confirmation).

**F.3 Budgets, Fixed Assets, Analytic**
- Budgets → `/finance/budgets/{new,:id/edit,:id}` on `RecordFormShell` (line grid for account budgets).
- Fixed Assets → same 4 surfaces + `?peek=<id>` `PeekScaffold`.
- Analytic Account → `DetailSheet`.

**F.4 Banking**
- Bank Account: `/finance/banking/accounts/{new,:id/edit}`; delete `ConnectBankDialog` + `EditBankAccountDialog`.
- Bank Reconciliation: `/finance/reconciliation/new` `WizardShell` (start ← `StartReconciliationDialog`; workspace row matching ← `ReconcileTransactionDialog`; bank-transfer match ← `TransferReconcileDialog`; commit). `/finance/reconciliation/:id` `RecordScaffold` split-view for the workspace.
- Bank Transactions Import → `/finance/banking/:id/import` `WizardShell` (file → mapping → preview → commit).
- Transaction Matching Rules → `/finance/banking/rules` list + `RecordFormShell` for new/edit.

**F.5 Customer Credits**
- Apply Credit → `/finance/customer-credits/:id/apply` `WizardShell`.
- Process Refund → `/finance/customer-credits/:id/refund` `WizardShell`.

**F.6 Legacy delete**
- Delete `CreditNoteDetailDialog.tsx` — Sales already owns the surface.

**F.7 Close-out**
- Every ledger row → `Done`.
- Shrink `finance-record-dialog-ban.test.ts` allowlist to `{ApplyDefaultMappingsDialog}` (permanent confirm-style).
- Add inline-dialog grep assertion for `src/pages/finance/*.tsx`.

## Cross-cutting invariants

- Every new route: `WorkspaceShell` → `PageHeader` → `PageBody` → `Section` from `@/design-system`. No bespoke shell markup.
- Every create/edit route: `RecordFormShell` + `useRecordFormSubmit`. No hand-rolled `<form>`, no bespoke Save/Cancel pair.
- Every peek: `PeekScaffold` / `DocumentPeekShell` reading via `useDocumentRecord` (or entity wrapper). Body reuses the same `*RecordBody` as the object page for peek/full parity.
- Design tokens only (`--ds-*`); no hardcoded colors/sizes.
- Responsive: two-column `FieldGrid` collapses to single-column at `sm:`; sticky `FooterActionBar` anchored to viewport bottom.
- TanStack Router flat-dot filenames; `createFileRoute` string matches generated id exactly.
- Guard-test allowlists only shrink.
- Update `mem://index.md` core rule allowlist counts as each phase closes (inventory 5→0, finance 14→1).

## Verification per app (checklist)

1. `bunx vitest run src/test/architecture/<app>-record-dialog-ban.test.ts` — green.
2. `rg -n "Dialog|Drawer" src/pages/<app-dirs>` — no create/edit/detail matches for the app's own records.
3. `tsgo` clean.
4. Manual click-through: list → row → `?peek=<id>` opens; "Open full page" → `/:id`; "New" → `/new`; edit → `/:id/edit`; submit → object page.
5. Ledger flipped to `Done` in `docs/design-system/audit/<app>.md`.

## Technical notes

- Reusable primitives already in `@/design-system` — do not duplicate: `RecordShell`, `RecordFormShell`, `RecordHeader`, `Section`, `FieldGrid`, `FooterActionBar`, `SummaryPanel`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `PeekScaffold`, `DocumentPeekShell`, `useDocumentRecord`, `usePeekParam`, `useRecordFormSubmit`, `WizardShell`.
- Extend `RecordShell` with `variant="split"` for reconciliation workspace instead of creating a new shell.
- Each entity gets a `use<Entity>Record` wrapper (same pattern as `useEstimateRecord`) shared by peek sheet + record page.
- Not in scope: DB schema, RLS, RPC surface, business logic, POS, HR/Payroll, Contacts create/edit (owned by Contacts module).

## Starting point after approval

Begin at **P.2 Vendor Statements**, then P.3 RFQs, then Purchases close-out, then move into Inventory Phase I.