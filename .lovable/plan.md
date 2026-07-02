## Independent assessment — what's actually done, and what isn't

I verified the previous agent's claims against the code rather than the notes. The picture is more mixed than the closing message suggested.

### Verified done (evidence)
- **Sales — record surface (Phase 1–3).** All 10 Sales entities (Invoices, Estimates, SO, Proforma, Delivery Notes, Credit Notes, Sales Returns, Recurring, Customer Payments, Customers) have `/list` → `?peek=<id>` `PeekScaffold` → `/:id` `RecordScaffold` → `/new` + `/:id/edit` on `RecordFormShell`. The `sales-record-dialog-ban.test.ts` allowlist is **empty**.
- **Purchases — record surface.** Bills, POs, GRN (wizard), Vendor Credit Notes, Purchase Returns, Vendor Price Lists, and Expenses all migrated. `purchases-record-dialog-ban.test.ts` allowlist is **empty**. Only remaining ledger row: RFQs + Vendor Statements — but the audit file still lists them **Pending**, so the guard is passing because those pages never used `Create*Dialog`/`Edit*Dialog` filenames, not because the surface is modern.
- **Shared primitives.** `RecordFormShell`, `useRecordFormSubmit`, `SalesRecordScaffold`, `SalesRecordBody`, `SalesPeekScaffold`, `DocumentPeekShell`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `useDocumentRecord`, `usePeekParam` — all present and re-exported from `@/design-system` / `@/features/sales/record`.

### Verified NOT done
- **Sales Phase 4 (Wizards).** `RecordPaymentDialog`, `PaymentHistoryDialog`, `VoidInvoiceDialog`, `BulkDeleteDialog`, `BulkExportDialog`, `PartialDeliveryDialog`, `ReturnDeliveryDialog`, `ContactMergeDialog`, `CustomerGroupsDialog`, `ProcessRefundDialog`, `ApplyCreditDialog` still live. The audit targets these for `WizardShell` or a config route.
- **Sales Phase 5.** No `/sales/configuration/*` routes exist.
- **Purchases residual.** `RFQs`, `VendorStatements`, and `BillingHistory` peeks/creates are still legacy per the audit ledger (`Pending` / `Verify`).
- **Inventory UX standardization — NOT STARTED.** No `docs/design-system/audit/inventory.md`. No `inventory-record-dialog-ban.test.ts`. The record/peek scaffolds are not adopted for Warehouses, Stock Adjustments, Stock Transfers, Physical Count, Scrap, Reorder Rules, Products, Product Categories, UoM, Lots, Reservations. The existing `TransferDetailDrawer`, `MovementDetailDrawer`, `WarehouseStockDrawer`, `ReverseAdjustmentDialog` are bespoke, not on `DocumentPeekShell` / `PeekScaffold`. The `inventory-verdict.md` file is a DB/RLS verdict, unrelated to UX.
- **Finance UX standardization — NOT STARTED.** No `docs/design-system/audit/finance.md`. No dialog-ban guard. `BusinessTransactionDialog`, `RecurringJournalDialog`, `YearEndClosingDialog`, `ApplyCreditDialog`, `ApplyDefaultMappingsDialog`, `ProcessRefundDialog`, `CreditNoteDetailDialog`, and the entire `src/components/banking/*Dialog.tsx` set (Connect / Edit / Import / Reconcile / StartRecon / TransactionRules / TransferReconcile) are legacy. Journal entries and reconciliation are prime `RecordFormShell` / `WizardShell` candidates. `finance-verdict.md` covers accounting invariants and RLS — not the interaction model.

### Cross-cutting gaps
- `SalesPeekScaffold`, `SalesRecordScaffold`, `SalesRecordBody`, `DocumentPeekShell`, `LineItemsGrid`, `DocumentTotalsPanel`, `DocumentActivityPanel` still live under `@/features/sales/record` and are imported cross-app. The audit calls out promoting them to `@/design-system` "in a later pass" — that pass hasn't happened. Purchases already reaches into `@/features/sales/record/*` (layering violation the audit explicitly forbids for future code).
- No architecture guard on `src/components/inventory` or `src/components/finance|banking` prevents new dialogs from landing.
- No `docs/design-system/audit/inventory.md` or `finance.md` to serve as the ledger the guard freezes against.

---

## Plan — finish the initiative, application by application, in the mandated order

Sequencing per the brief: **finish Sales → finish Purchases → do Inventory → do Finance**. Each application ends with (a) audit ledger green, (b) dialog-ban guard passing with empty allowlist, (c) typecheck + build clean.

### Wave 0 — Promote shared primitives (unblocks Inventory & Finance)
Move the record/peek scaffold from `@/features/sales/record` into `@/design-system/records/*` and re-export the Sales-namespaced barrel as thin wrappers for back-compat. Rename to domain-neutral names: `DocumentRecordScaffold`, `DocumentPeekScaffold`, `DocumentRecordBody`. This kills the layering violation and lets Purchases/Inventory/Finance import from `@/design-system` cleanly.

### Wave 1 — Close Sales Phase 4 + Phase 5
- Migrate `RecordPaymentDialog` (invoice + standalone) → `/sales/payments/new?invoice=<id>` on `WizardShell`.
- Migrate `PaymentHistoryDialog` → inline section on Invoice record aside (already the target per audit row 5).
- Migrate `ProcessRefundDialog`, `ApplyCreditDialog`, `PartialDeliveryDialog`, `ReturnDeliveryDialog` → dedicated wizard routes under `/sales/returns/:id/refund`, `/sales/credit-notes/:id/apply`, `/sales/orders/:id/deliver`, `/sales/orders/:id/return`.
- `ContactMergeDialog` → `/sales/customers/merge` wizard.
- `CustomerGroupsDialog` → `/sales/configuration/customer-groups` object page.
- Build the five `/sales/configuration/*` object pages (customer-groups, price-lists, invoice-templates, payment-terms, tax-defaults) on `RecordScaffold` + `RecordFormShell`.
- `VoidInvoiceDialog`, `BulkDeleteDialog`, `BulkExportDialog`, `BulkExportEstimatesDialog`, `ContactDeleteDialog` — remain `Dialog` (confirm-style, target column says "keep").
- Tighten `sales-record-dialog-ban.test.ts` to also forbid new `*Dialog.tsx` inside `src/components/sales` unless it's a confirm/picker with ≤6 fields (allowlist the keep set).

### Wave 2 — Close Purchases residual
- RFQs: `/purchases/rfqs/new` + `/:id/edit` + `?peek=<id>` on the promoted scaffolds; delete legacy `RFQs.tsx` inline dialog.
- Vendor Statements: `/purchases/statements/:vendor_id` record page + peek sheet.
- Billing History: verify legacy files are gone; if a peek remains, replace with `DocumentPeekShell`.
- Update `docs/design-system/audit/purchases.md` — flip the three "Pending" rows to "Done"; the guard already blocks new dialogs.

### Wave 3 — Inventory UX standardization (application-complete)
1. Write `docs/design-system/audit/inventory.md` — the ledger with every entity and its Today/Target/Status column. Entities in scope:
   - Warehouses, Warehouse Stock, Stock Adjustments, Stock Transfers, Physical Count, Scrap, Reorder Rules, Replenishment Logs, Products, Product Categories, UoM & Packaging, Lots, Reservations, Barcode Enrollment.
2. Land `inventory-record-dialog-ban.test.ts` with a frozen allowlist that only shrinks.
3. Nav shell: every inventory page uses `PlatformShell` + `INVENTORY_NAV` (Operations / Insights / Setup groups) matching Sales/Purchases.
4. Migrate each entity, in dependency order:
   - **Setup first** (Warehouses, UoM/Packaging, Product Categories, Reorder Rules, Barcode Enrollment configuration) → `RecordFormShell` + `PeekScaffold`.
   - **Operations** (Stock Adjustment, Stock Transfer, Physical Count, Scrap, Movement/Lot peek) — the ones with line items get `LineItemsGrid` + `DocumentTotalsPanel`; existing `TransferDetailDrawer`, `MovementDetailDrawer`, `WarehouseStockDrawer`, `ReverseAdjustmentDialog` are replaced.
   - **Products** — `/inventory/products/new`, `/:id/edit`, `/:id` on the shared record scaffold; retire any inline Product create dialog on `src/pages/Products.tsx`.
5. Reconcile `?peek=<id>` on every list.
6. Green the ledger + guard.

### Wave 4 — Finance UX standardization (application-complete)
1. Write `docs/design-system/audit/finance.md`. Entities:
   - Journal Entries, Journal Books, Chart of Accounts, Fiscal Periods, Budgets, Analytic Accounts, Fixed Assets, Bank Accounts, Bank Transactions, Bank Reconciliation, Bank Transfers, Bank Rules, Recurring Journals, Year-End Close, Customer Credits, Apply-Credit, Refund, Business Transaction (JE quick-post), Default-Account Mappings, Statements (AR/AP already Sales/Purchases).
2. Land `finance-record-dialog-ban.test.ts` covering `src/components/finance` + `src/components/banking` + `src/components/accounting`.
3. Migrate:
   - **Journal Entry** (`create`/`edit`/`view`) → `/finance/journal-entries/new` + `/:id/edit` + `/:id` on `RecordFormShell` + `RecordScaffold` with `LineItemsGrid` for JE lines. Retire `BusinessTransactionDialog` (converts to `/finance/journal-entries/new?template=business`), `RecurringJournalDialog` (→ `/finance/recurring-journals/*`).
   - **Bank account** → `/finance/banking/accounts/new` + `/:id/edit` (retires `ConnectBankDialog`, `EditBankAccountDialog`).
   - **Bank reconciliation** → `/finance/reconciliation/:id` split-view workspace on `RecordScaffold` + `WizardShell`; `StartReconciliationDialog` becomes `/new`, `ReconcileTransactionDialog` becomes inline row-edit inside the workspace, `TransferReconcileDialog` becomes a wizard step, `ImportTransactionsDialog` becomes `/finance/banking/:id/import` wizard, `TransactionRulesDialog` becomes `/finance/banking/rules` object page.
   - **Year-End Close** → `/finance/fiscal-periods/close` wizard.
   - **Customer credits & refund flows** → wizard routes; `CreditNoteDetailDialog` in `src/components/finance` is dead-code candidate (the sales credit-note peek supersedes it) — delete after verifying no imports.
4. Green the ledger + guard.

### Wave 5 — Cross-app parity sweep
- Every module imports scaffolds from `@/design-system` only.
- Delete `@/features/sales/record/*` shim once no cross-app imports remain (keep re-exports for one release cycle if any Sales-internal import still points at it).
- Update `mem://index.md` Core with the two invariants: "Business records use `RecordFormShell`/`RecordScaffold`/`PeekScaffold` from `@/design-system` — never per-entity dialogs" and "Dialogs are reserved for confirms, ≤6-field pickers, print preview, and email send".
- Run `bun test` (all architecture guards) + `tsgo` + `build:dev`. Ledger files updated with a final "Verdict" section per application.

## Verification per wave
- `find src/components/{inventory,finance,banking,accounting,invoices,estimates,sales,contacts,bills,vendors,purchases,expenses,rfqs} -name "*Dialog.tsx"` returns only confirm/picker dialogs.
- The four dialog-ban guards pass with empty allowlists.
- Playwright: open one record from each list per app, verify `?peek=<id>` mounts a peek sheet with "Open full page", verify `/new` and `/:id/edit` render `RecordFormShell` with sticky footer and multi-column `FieldGrid`.
- Typecheck + `build:dev` green.

## Deferred / non-goals
- No changes to the accounting engine, RLS policies, or business logic. The `finance-verdict.md` and `inventory-verdict.md` invariants stay untouched — this is a UX/interaction pass.
- POS and HR/Payroll are already the reference; not in scope.
- Custom-domain and publishing are user-driven, not part of this initiative.
