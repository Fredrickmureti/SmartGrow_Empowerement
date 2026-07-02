## Independent status check (what the previous agent actually left)

Verified against the codebase (not the notes):

- **Sales** — allowlist in `sales-record-dialog-ban.test.ts` is empty. All 10 entities have `/new`, `/:id/edit`, `/:id`, and `?peek=<id>` on `RecordFormShell` / `SalesRecordScaffold` / `SalesPeekScaffold`. Design-system primitives (`RecordFormShell`, `useRecordFormSubmit`) exist and are exported from `@/design-system`. **Sales: done.**
- **Purchases** — `purchases-record-dialog-ban.test.ts` allowlist is empty; Bills / POs / Goods Receipts / Vendor Credit Notes / Purchase Returns / Vendor Price Lists / Expenses (peek) are migrated. Still pending per `docs/design-system/audit/purchases.md`: **Expenses create/edit** (inline dialog inside `src/pages/Expenses.tsx`), **Vendor Statements peek + record page**, **RFQs create/edit** (inline dialog inside `src/pages/RFQs.tsx`). The guard doesn't catch them because they're inline JSX, not `Create*Dialog.tsx` files — real pending work.
- **Inventory** — allowlist has 5 legacy drawers, and every create/edit surface (Warehouse, Adjustment, Transfer, Physical Count, Scrap, Reorder Rule, Product, Category, UoM, Lot, Reservation) is still an inline dialog. Essentially untouched.
- **Finance** — allowlist has 14 dialogs (13 migration targets + 1 permanent confirm-style). Nothing migrated.

Previous agent's last claim ("Expenses migrated, purchases guard empty") is accurate as far as it goes, but the ledger's remaining Purchases rows (Expenses create/edit, Vendor Statements, RFQs) are still legacy.

## Sequencing (per the prompt's "complete one app before moving on" rule)

1. **Purchases tail** — close the remaining 3 rows in the ledger. This finalizes Purchases.
2. **Inventory — full migration** — every row in `docs/design-system/audit/inventory.md`.
3. **Finance — full migration** — every row in `docs/design-system/audit/finance.md`.

Each app finishes with: guard test green + empty (or shrink-only permanent-confirm-style) allowlist, ledger rows all `Done`, typecheck clean, no legacy dialog file left with a live import.

---

## Phase P — Purchases tail (finish the app)

**P.1 Expenses**
- New: `/purchases/expenses/new`, `/purchases/expenses/:id/edit` — `ExpenseCreatePage`, `ExpenseEditPage` on `RecordFormShell` + `useRecordFormSubmit`.
- Read-only object page `/purchases/expenses/:id` on `RecordScaffold` (reuse `ExpensePeekSheet` sections via a shared `ExpenseRecordBody`).
- Retire the inline create/edit `Dialog` in `src/pages/Expenses.tsx`; row-click → `?peek=<id>`, "New expense" → `/purchases/expenses/new`, "Edit" → `/…/edit`.

**P.2 Vendor Statements**
- `?peek=<vendorId>` peek sheet + `/purchases/statements/:vendor_id` record page on `RecordScaffold`. Replace the inline peek dialog in `src/pages/purchases/VendorStatements.tsx`.

**P.3 RFQs**
- `/purchases/rfqs/new`, `/purchases/rfqs/:id/edit`, `/purchases/rfqs/:id`, `?peek=<id>` — full 4-surface set on `RecordFormShell` / `RecordScaffold` / `PeekScaffold`. Retire the inline dialog in `src/pages/RFQs.tsx`.

**P.4 Ledger + guard**
- Flip all three rows to `Done` in `docs/design-system/audit/purchases.md`.
- Add a *layering* assertion to the Purchases guard: no `<Dialog … open` block referencing a create/edit/detail concern in `src/pages/Expenses.tsx`, `src/pages/RFQs.tsx`, `src/pages/purchases/VendorStatements.tsx` (grep-based, small and precise). Prevents inline-JSX regressions the file-name pattern misses.

---

## Phase I — Inventory (full app)

Order matches the ledger. Each entity gets the standard 4 surfaces (`/new`, `/:id/edit`, `/:id`, `?peek=<id>`) unless noted.

**I.1 Read-only object pages + peek sheets first** (retires the 5 legacy drawers → allowlist to 0):
- Warehouse Stock → `WarehouseStockPeekSheet` (`PeekScaffold`), delete `WarehouseStockDrawer.tsx`.
- Stock Movement → `StockMovementPeekSheet`, delete `MovementDetailDrawer.tsx`.
- Stock Movement source doc → delegate to source app's peek (Sales/Purchases peek routes already exist), delete `SourceDocumentDrawer.tsx`.
- Stock Adjustment → `AdjustmentPeekSheet` + `/inventory/adjustments/:id`, delete `AdjustmentDetailDrawer.tsx`.
- Stock Transfer → `TransferPeekSheet` + `/inventory/transfers/:id`, delete `TransferDetailDrawer.tsx`.

**I.2 Create/edit routes on `RecordFormShell`**:
- Warehouse (`/inventory/warehouses/new` + `/:id/edit` + `/:id`).
- Stock Adjustment (line-item grid, cost-required rule from mem/core enforced client-side).
- Stock Transfer (line-item grid, from/to warehouse fields).
- Scrap / Write-off (`/inventory/scrap/new`).
- Product + Product Category (`/inventory/products/new` + `/:id/edit` + `/:id`; category as `DetailSheet`).
- Reorder Rule (`DetailSheet` per target).
- UoM & Packaging (`DetailSheet`).

**I.3 Wizards**:
- Physical Count → `/inventory/physical-count/new` on `WizardShell` (steps: scope → counting → variance review → commit). `/inventory/physical-count/:id` on `RecordScaffold` for in-progress + completed sessions.

**I.4 Peek-only entities** (`PeekScaffold`, no /new): Stock Lot, Stock Reservation, Reorder Rule peek.

**I.5 Ledger + guard**
- Every row → `Done` in `docs/design-system/audit/inventory.md`.
- Empty the `inventory-record-dialog-ban.test.ts` allowlist.
- Add an inline-dialog grep assertion for `src/pages/Products.tsx`, `src/pages/inventory/*.tsx`.

---

## Phase F — Finance (full app)

Order: read-only + peek surfaces first so the object-page destinations exist before create/edit routes are wired.

**F.1 Journal Entry family**
- `/finance/journal-entries/:id` (`RecordScaffold`) + `?peek=<id>` (`PeekScaffold`) with debit/credit `LineItemsGrid`.
- `/finance/journal-entries/new` + `/:id/edit` on `RecordFormShell` with the JE line grid (balanced-entry validation stays client-side, plus DB constraint).
- `BusinessTransactionDialog` → same `/new?template=business` route with a template selector step; delete the dialog.
- `RecurringJournalDialog` → `/finance/recurring-journals/new` + `/:id/edit` + `/:id` + `?peek=<id>` on `RecordFormShell` / `RecordScaffold`; delete the dialog.

**F.2 Chart of Accounts + Fiscal**
- `/finance/accounts/new` + `/:id/edit` on `RecordFormShell`.
- Fiscal Period → `DetailSheet` (≤6 fields).
- Year-End Close → `/finance/fiscal-periods/close` `WizardShell` (steps: period selection → validation → post → confirmation).

**F.3 Budgets, Fixed Assets, Analytic**
- Budgets → `/finance/budgets/new` + `/:id/edit` + `/:id` on `RecordFormShell` (line grid for account budgets).
- Fixed Assets → same 4 surfaces + `?peek=<id>` `PeekScaffold`.
- Analytic Account → `DetailSheet`.

**F.4 Banking**
- Bank Account: `/finance/banking/accounts/new` + `/:id/edit` on `RecordFormShell`; delete `ConnectBankDialog` + `EditBankAccountDialog`.
- Bank Reconciliation: `/finance/reconciliation/new` `WizardShell` (start step ← `StartReconciliationDialog`; workspace step for row matching ← `ReconcileTransactionDialog`; bank-transfer match step ← `TransferReconcileDialog`; commit step). `/finance/reconciliation/:id` `RecordScaffold` split-view for the workspace.
- Bank Transactions Import → `/finance/banking/:id/import` `WizardShell` (file → mapping → preview → commit).
- Transaction Matching Rules → `/finance/banking/rules` `RecordScaffold` list + `RecordFormShell` for new/edit.

**F.5 Customer Credits**
- Apply Credit → `/finance/customer-credits/:id/apply` `WizardShell`.
- Process Refund → `/finance/customer-credits/:id/refund` `WizardShell`.

**F.6 Legacy delete**
- Delete `CreditNoteDetailDialog.tsx` — Sales already owns the surface.

**F.7 Ledger + guard**
- Every row → `Done`.
- Shrink `finance-record-dialog-ban.test.ts` allowlist to `{ApplyDefaultMappingsDialog}` (the one permanent confirm-style entry).
- Add inline-dialog grep assertion for `src/pages/finance/*.tsx`.

---

## Cross-cutting invariants (apply throughout)

- Every new route uses `WorkspaceShell` → `PageHeader` → `PageBody` → `Section` chain from `@/design-system` per `docs/design-system.md`. No bespoke shell markup.
- Every create/edit route uses `RecordFormShell` + `useRecordFormSubmit`. No hand-rolled `<form>`, no hand-rolled `useState + try/catch + toast` triad, no bespoke Save/Cancel button pair.
- Every peek uses `PeekScaffold` / `DocumentPeekShell` and reads its record via `useDocumentRecord` (or the entity-specific wrapper). Body reuses the same `*RecordBody` component as the object page to guarantee peek/full parity.
- Design tokens only (`--ds-*`). No hardcoded `text-[Npx]`, `p-[Npx]`, `rounded-[Npx]`, `bg-white`.
- Responsive: two-column `FieldGrid` on desktop collapses to single column at `sm:`; sticky `FooterActionBar` anchored to viewport bottom.
- All route filenames follow TanStack Router flat-dot convention; `createFileRoute` string matches the generated route id exactly.
- Guard tests run in CI as part of the normal `vitest` suite — never expand an allowlist.
- Update `mem://index.md` core rule allowlist counts as each phase closes (inventory 5→0, finance 14→1).

## Verification per app (checklist run before advancing)

1. `bunx vitest run src/test/architecture/<app>-record-dialog-ban.test.ts` — green.
2. `rg -n "Dialog|Drawer" src/pages/<app-dirs>` — no create/edit/detail matches for the app's own records.
3. `tsgo` clean.
4. Manual click-through: list → row → `?peek=<id>` opens; "Open full page" → `/:id`; "New" → `/new`; edit action → `/:id/edit`; submit → object page.
5. Ledger flipped to `Done` in `docs/design-system/audit/<app>.md` with dated progress entry.

## Technical details

- **Reusable primitives already in place** (do not duplicate): `RecordShell`, `RecordFormShell`, `RecordHeader`, `Section`, `FieldGrid`, `FooterActionBar`, `SummaryPanel`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `PeekScaffold`, `DocumentPeekShell`, `useDocumentRecord`, `usePeekParam`, `useRecordFormSubmit`.
- **Missing pieces to add** (once, then reused):
  - `WizardShell` promotion into `@/design-system` if still living in features (verify during Phase I.3).
  - `RecordScaffold` variant for split-view (needed for reconciliation workspace) — extend existing `RecordShell` with a `variant="split"` prop instead of a new component.
- **Data hooks**: each entity gets a `use<Entity>Record` wrapper around `useDocumentRecord` (same pattern as `useEstimateRecord`) — the peek sheet and the record page share it.
- **Not in scope**: DB schema, RLS, RPC surface, business logic, POS, HR/Payroll (already the reference), Contacts create/edit (owned by Contacts module and deferred in the Purchases ledger).