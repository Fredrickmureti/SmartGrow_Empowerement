# Finance — Enterprise UX Audit

Companion to [`docs/design-system/records.md`](../records.md). Tracks every
create / edit / duplicate / convert / configure / peek surface in the
Finance application against the enterprise UX standard.

Legend for **Target**:

- **Route + `RecordFormShell`** — full-page create/edit on a dedicated route
- **Route + `RecordScaffold`** — read-only object page
- **`PeekScaffold`** — `?peek=<id>` deep-link peek + "Open full page"
- **`DetailSheet`** — small (~≤6 fields, no line items) form sheet
- **`WizardShell`** — multi-step workflow (reconciliation, year-end close, import)
- **`Dialog`** — confirmations, ≤6-field pickers (allowed)

| Entity | Surface | Today | Target | Status |
| --- | --- | --- | --- | --- |
| Journal Entry | Create | Route + `RecordFormShell` at `/finance/journal-entries/new` | Route + `RecordFormShell` at `/finance/journal-entries/new` (with balanced-line grid) | Done |
| Journal Entry | Edit | Route + `RecordFormShell` at `/finance/journal-entries/:id/edit` | Route + `RecordFormShell` at `/finance/journal-entries/:id/edit` | Done |
| Journal Entry | View | Route + `RecordScaffold` at `/finance/journal-entries/:id` (`JournalEntryDetailPage`) | Route + `RecordScaffold` at `/finance/journal-entries/:id` | Done |
| Journal Entry | Peek (list) | `JournalEntryPeekSheet` on `PeekScaffold` behind `?peek=<id>` | `PeekScaffold` behind `?peek=<id>` | Done |
| Business Transaction (JE quick-post) | Route + `RecordFormShell` at `/finance/business-transactions/new?type=<t>` (`BusinessTransactionCreatePage`) | Route + `RecordFormShell` at `/finance/business-transactions/new` | Done |
| Recurring Journal | Route + `RecordFormShell` at `/finance/recurring-journals/new` (`RecurringJournalCreatePage`) | Route + `RecordFormShell` at `/finance/recurring-journals/new` + `/:id/edit` + `PeekScaffold` | Create Done · Edit/Peek deferred (no list surface today) |
| Chart of Accounts entry | Create / Edit | Route + `RecordFormShell` at `/finance/accounts/new` (`AccountCreatePage`) + `/:id/edit` (`AccountEditPage`) | Route + `RecordFormShell` at `/finance/accounts/new` + `/:id/edit` | Done |
| Fiscal Period | Create / Edit | `GeneratePeriodsSheet` (`DetailSheet`) | `DetailSheet` (≤6 fields) | Done |
| Year-End Close | Route + `RecordScaffold` at `/finance/year-end-close` (`YearEndClosePage`); `YearEndClosingDialog` deleted | `WizardShell` at `/finance/fiscal-periods/close` | Done (page-based; deviation from wizard target — dialog deleted) |
| Budget | Create / Edit | `BudgetFormSheet` + `BudgetItemSheet` + `ManageBudgetSheet` (Sheet-based) | Route + `RecordFormShell` at `/finance/budgets/new` + `/:id/edit` (line grid for account budgets) | **Deviation** — sheets shipped; promotion to routes pending |
| Fixed Asset | Create / Edit | Route + `RecordFormShell` at `/finance/fixed-assets/new` (`AssetCreatePage`) + `/:id/edit` (`AssetEditPage`); `AssetFormSheet` deleted | Route + `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit` | Done |
| Fixed Asset | Peek | `AssetPeekSheet` on `PeekScaffold` behind `?peek=<id>`; `AssetDetailSheet` deleted | `PeekScaffold` | Done |
| Analytic Account | Create / Edit | `AnalyticAccountSheet` + `AnalyticGroupSheet` (`DetailSheet`) | `DetailSheet` | Done |
| Bank Account | Connect / Edit | `BankAccountSheet` at `?sheet=account[&id=…]` (Sheet-based; `ConnectBankDialog` + `EditBankAccountDialog` deleted) | Route + `RecordFormShell` at `/finance/banking/accounts/new` + `/:id/edit` | **Deviation** — unified sheet shipped; promotion to routes pending |
| Bank Reconciliation | Start | Route + `RecordFormShell` at `/finance/reconciliation/new` (`StartReconciliationPage`); `StartReconciliationDialog` deleted | Route + `WizardShell` at `/finance/reconciliation/new` | Done (form-based; single-step route on `RecordFormShell` — dialog deleted) |
| Bank Reconciliation | Workspace | `ReconcileTransactionDialog` (row-by-row) | Route + `RecordScaffold` split-view at `/finance/reconciliation/:id` (row edit inline in the workspace) | **Pending** |
| Bank Transfer Reconcile | `TransferReconcileDialog` | Step inside the reconciliation workspace `WizardShell` | **Pending** |
| Bank Transactions Import | `ImportTransactionsDialog` | `WizardShell` at `/finance/banking/:id/import` | **Pending** |
| Transaction Matching Rules | `TransactionRulesDialog` | Route + `RecordScaffold` at `/finance/banking/rules` + `RecordFormShell` for new/edit | **Pending** |
| Customer Credit — Apply | Route + `WizardShell` at `/finance/customer-credits/:id/apply` (`ApplyCreditWizardPage`); `ApplyCreditDialog` deleted | `WizardShell` at `/finance/customer-credits/:id/apply` | Done |
| Customer Credit — Refund | Route + `WizardShell` at `/finance/customer-credits/:id/refund` (`ProcessRefundWizardPage`); `ProcessRefundDialog` deleted | `WizardShell` at `/finance/customer-credits/:id/refund` | Done |
| Default Account Mappings — Apply | `ApplyDefaultMappingsDialog` | `Dialog` (allowed — confirm-style) | Done |
| Credit Note (legacy finance surface) | Deleted — call sites now use Sales `CreditNotePeekSheet` at `?peek=<id>` and the full page at `/sales/credit-notes/:id` | Delete — superseded by Sales `/sales/credit-notes/:id` + peek | Done |

## Enforcement

Every new file under `src/components/finance`, `src/components/banking`,
or `src/components/accounting` matching either:

- `Create*Dialog.tsx` / `Edit*Dialog.tsx` — must be a `/new` or `/:id/edit`
  route on `RecordFormShell`, or
- `*DetailDialog.tsx` — must be a `*PeekSheet.tsx` on `PeekScaffold`,

is blocked by [`src/test/architecture/finance-record-dialog-ban.test.ts`](../../../src/test/architecture/finance-record-dialog-ban.test.ts).
The allowlist is frozen against the 14 legacy dialogs listed today and
may only shrink.

## Standard imports

Finance modules import scaffolds from `@/design-system` only. Never
reach into `@/features/sales/record/*` — the scaffolds have been
promoted to `@/design-system/records`.
