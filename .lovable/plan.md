## Independent assessment

I re-verified the previous agent's claims against the codebase before planning. Findings:

**Sales** — audit doc marks everything Done; `sales-record-dialog-ban.test.ts` passes; both allowlists (create/edit + peek) are empty. No outstanding work.

**Purchases** — audit doc all Done; `purchases-record-dialog-ban.test.ts` passes; allowlists empty. No outstanding work.

**Inventory** — Warehouses, Adjustments, Transfers, Scrap, UoM, and (as of the last turn) Products are migrated. `ProductForm.tsx` (1091 lines) + `ProductNew.tsx` + `ProductEdit.tsx` exist; `src/apps/inventory/routes.tsx` registers `products/new` and `products/:id/edit`; the inline product record dialog in `src/pages/Products.tsx` is gone (`ProductDetailPanel` peek remains, which is expected). Guard test green. Remaining Slice A items match the previous agent's note.

**Finance** — audit doc all Pending. `finance-record-dialog-ban.test.ts` **fails**: the allowlist has only `ApplyDefaultMappingsDialog` but 12 legacy dialogs still exist on disk under `src/components/finance` and `src/components/banking`. Nothing has been migrated in Finance yet.

**Typecheck** — `tsgo --noEmit` clean.

**Conclusion** — the previous agent's status report is accurate. Pick up exactly where they stopped: finish Inventory Slice A, then execute the full Finance migration.

---

## Plan

### Phase 1 — Inventory Slice A (finish inventory)

Reuse the existing design-system scaffolds (`RecordFormShell`, `DetailSheet`, `WizardShell`, `PeekScaffold`, `useRecordFormSubmit`) — no new primitives.

1. **Product Category** → `DetailSheet` (≤6 fields: name, parent, code, description, default income/expense accounts). Replace the inline create/edit dialog in `src/pages/Products.tsx` (Categories Manager) with the sheet. No route needed.
2. **Physical Count** → `WizardShell` at `/inventory-app/physical-count/new` + `RecordScaffold` at `/inventory-app/physical-count/:id`. Steps: Scope (warehouse + filters) → Count (line grid with expected vs counted qty) → Review & commit (posts adjustment JE preview + variance summary). Retire the inline dialog in `src/pages/inventory/PhysicalCount.tsx`.
3. **Reorder Rule** → `DetailSheet` for create/edit (product, warehouse, min qty, max qty, reorder qty, active) + `PeekScaffold` `?peek=<id>` for the list. Retire the inline dialog.
4. **Stock Lot peek** → `StockLotPeekSheet` on `PeekScaffold` behind `?peek=<id>` on the lot list. Retire inline dialog.
5. **Stock Reservation peek** → `StockReservationPeekSheet` on `PeekScaffold` behind `?peek=<id>`. Retire inline dialog.
6. Update `docs/design-system/audit/inventory.md` — flip each row to Done, drop the pending header note.
7. Guard: `inventory-record-dialog-ban.test.ts` must stay green (allowlist stays empty).

### Phase 2 — Finance (full migration, 12 legacy surfaces)

Per `docs/design-system/audit/finance.md`. All routes register in the finance app's route file; each entity uses the shared `RecordFormShell` / `WizardShell` / `PeekScaffold` / `LineItemsGrid` / `useRecordFormSubmit`.

**Journal Entries (foundational — start here)**
- `RecordFormShell` at `/finance/journal-entries/new` and `/:id/edit`, with `LineItemsGrid` for lines (account, debit, credit, description, analytic tags), balancing indicator, attach source doc.
- `RecordScaffold` at `/finance/journal-entries/:id`.
- `PeekScaffold` `?peek=<id>` on the list; retire `JournalEntryDetailRedirect` inline path.
- `BusinessTransactionDialog` → deep-link `/finance/journal-entries/new?template=business` on the same shell.
- `RecurringJournalDialog` → `/finance/recurring-journals/new` + `/:id/edit` + `PeekScaffold`.

**Chart of Accounts** — `RecordFormShell` at `/finance/accounts/new` + `/:id/edit` (identity, type, parent, currency, tax mapping, tags, opening balance).

**Fiscal Periods** — `DetailSheet` for create/edit (≤6 fields). `YearEndClosingDialog` → `WizardShell` at `/finance/fiscal-periods/close` (steps: Scope → Adjustments preview → Post & lock).

**Budgets** — `RecordFormShell` at `/finance/budgets/new` + `/:id/edit` with `LineItemsGrid` for account budgets by period.

**Fixed Assets** — `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit` (identity, category, acquisition, depreciation method/life, salvage, GL mapping) + `PeekScaffold` on the list.

**Analytic Accounts** — `DetailSheet` (≤6 fields).

**Banking**
- `ConnectBankDialog` → `RecordFormShell` at `/finance/banking/accounts/new`.
- `EditBankAccountDialog` → `RecordFormShell` at `/finance/banking/accounts/:id/edit`.
- `StartReconciliationDialog` + `ReconcileTransactionDialog` + `TransferReconcileDialog` → single `WizardShell` at `/finance/reconciliation/new` and split-view `RecordScaffold` at `/finance/reconciliation/:id` (row-edit inline in workspace, transfer-reconcile is a workspace step).
- `ImportTransactionsDialog` → `WizardShell` at `/finance/banking/:id/import` (Upload → Map columns → Preview → Commit).
- `TransactionRulesDialog` → `RecordScaffold` at `/finance/banking/rules` + `RecordFormShell` for new/edit.

**Customer Credits**
- `ApplyCreditDialog` → `WizardShell` at `/finance/customer-credits/:id/apply`.
- `ProcessRefundDialog` → `WizardShell` at `/finance/customer-credits/:id/refund`.

**Legacy cleanup** — delete `CreditNoteDetailDialog` (superseded by Sales `/sales/credit-notes/:id`); repoint any remaining consumers to the Sales route + peek.

**Kept as Dialog** — `ApplyDefaultMappingsDialog` (confirm-style, already Done).

**Guard** — as each migration lands, delete the dialog file. Once all 12 are gone, `finance-record-dialog-ban.test.ts` returns to green with an empty allowlist. Add finance list pages to an inline-dialog scanner section mirroring the inventory guard so no regressions land.

**Audit doc** — flip every Finance row to Done as it ships; add a shortlist banner ("all record surfaces routed") at the end.

### Phase 3 — Cross-app integrity pass

1. Grep for any lingering `import ...Dialog` referencing migrated files across the whole tree; fix or remove.
2. Verify deep-links: `?action=create`, `?peek=<id>`, and inbound navigation from dashboards / notifications / command palette resolve to the new routes.
3. Run `bunx tsgo --noEmit` and the full architecture test suite; both must be green before finishing each phase.
4. Confirm no reach-through into `@/features/sales/record/*` from Finance or Inventory (per audit docs).

### Technical notes

- No new design-system primitives — everything already exists (`RecordFormShell`, `WizardShell`, `PeekScaffold`, `DetailSheet`, `LineItemsGrid`, `useRecordFormSubmit`, `SalesPeekScaffold`, `DocumentPeekShell`, `SummaryPanel`, `DocumentTotalsPanel`, `DocumentActivityPanel`).
- Reconciliation is the highest-risk Finance slice (three interlocking dialogs → one workspace); build the workspace scaffold first, then port each dialog as a workspace region/step.
- Preserve all existing RPC calls, RLS-scoped queries, branch/business scoping, and toast wording verbatim during each port — this is a UX/architecture migration, not a business-logic change.
- Ship each entity in its own turn: routes → callsite migration → delete legacy dialog file → audit doc flip → guard test green. Do not batch multiple entities into one atomic drop.

Ping me to switch to build mode and I'll start with Inventory Slice A item 1 (Product Category `DetailSheet`).