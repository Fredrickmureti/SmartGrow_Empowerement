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
| Budget | Create | Route + `RecordFormShell` at `/finance/budgets/new` (`BudgetCreatePage`) | Route + `RecordFormShell` at `/finance/budgets/new` | Done |
| Budget | Edit / Manage | Route + `RecordFormShell` at `/finance/budgets/:id/edit` (`BudgetEditPage`) with inline add-line composer, variance summary, and BvA chart; `BudgetFormSheet` + `BudgetItemSheet` + `ManageBudgetSheet` deleted | Route + `RecordFormShell` at `/finance/budgets/:id/edit` (line grid for account budgets) | Done |
| Budget | Copy to next year | `CopyBudgetDetailSheet` (`DetailSheet`, 2 fields — confirm-style, allowlisted) | `DetailSheet` (≤6 fields) | Done |
| Fixed Asset | Create / Edit | Route + `RecordFormShell` at `/finance/fixed-assets/new` (`AssetCreatePage`) + `/:id/edit` (`AssetEditPage`); `AssetFormSheet` deleted | Route + `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit` | Done |
| Fixed Asset | Peek | `AssetPeekSheet` on `PeekScaffold` behind `?peek=<id>`; `AssetDetailSheet` deleted | `PeekScaffold` | Done |
| Analytic Account | Create / Edit | `AnalyticAccountSheet` + `AnalyticGroupSheet` (`DetailSheet`) | `DetailSheet` | Done |
| Bank Account | Connect / Edit | Route + `RecordFormShell` at `/finance/banking/accounts/new` (`BankAccountCreatePage`) + `/:id/edit` (`BankAccountEditPage`); `BankAccountSheet` + `ConnectBankDialog` + `EditBankAccountDialog` deleted | Route + `RecordFormShell` at `/finance/banking/accounts/new` + `/:id/edit` | Done |
| Bank Reconciliation | Start | Route + `RecordFormShell` at `/finance/reconciliation/new` (`StartReconciliationPage`); `StartReconciliationDialog` deleted | Route + `WizardShell` at `/finance/reconciliation/new` | Done (form-based; single-step route on `RecordFormShell` — dialog deleted) |
| Bank Reconciliation | Workspace | `ReconcileTransactionSheet` (row-by-row `DetailSheet` side rail; `ReconcileTransactionDialog` deleted) | Enterprise side rail on `DetailSheet` (no modal); full workspace split-view promotion tracked separately | Done (side-rail; modal eliminated — split-view route deferred) |
| Bank Transfer Reconcile | `TransferReconcileSheet` (`DetailSheet` side rail; `TransferReconcileDialog` deleted) | Enterprise side rail on `DetailSheet` (no modal) | Done (side-rail; modal eliminated) |
| Bank Transactions Import | Route + `WizardShell` at `/finance/banking/import` (`ImportStatementWizardPage`; optional `?accountId=<id>` preselection); `ImportTransactionsDialog` deleted | `WizardShell` at `/finance/banking/import` (Upload → Map → Preview → Complete) | Done |
| Transaction Matching Rules | Routes at `/finance/banking/rules` (list — `RulesListPage`), `/finance/banking/rules/new` (`RuleCreatePage`), `/finance/banking/rules/:id/edit` (`RuleEditPage`); `TransactionRulesDialog` deleted | Route + `PageHeader`/`PageBody`/`Section` list + `RecordFormShell` for new/edit | Done |
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

Post Wave 11 the guard is **frozen**: the allowlist contains only two
genuine confirm-style utilities — `CopyBudgetDetailSheet.tsx` (2 fields)
and `ApplyDefaultMappingsDialog.tsx` (preview). The scan now also
covers `src/components/budgets` and `src/features/finance/**`, and
additionally rejects verb-noun dialogs (`Reconcile*Dialog`,
`Match*Dialog`, `Apply*Dialog`, etc.) and the `*FormSheet` /
`*ItemSheet` / `Manage*Sheet` naming patterns Wave 8 eliminated for
budgets. Any new dialog or sheet under those trees is a hard build
failure unless explicitly added to `LEGACY_DIALOG_ALLOWLIST` with a
documented confirm-style justification.

## Standard imports

Finance modules import scaffolds from `@/design-system` only. Never
reach into `@/features/sales/record/*` — the scaffolds have been
promoted to `@/design-system/records`.
