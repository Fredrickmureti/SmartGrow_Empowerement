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
| Journal Entry | View | inline (via `JournalEntryDetailRedirect`) | Route + `RecordScaffold` at `/finance/journal-entries/:id` | **Pending** |
| Journal Entry | Peek (list) | inline dialog | `PeekScaffold` behind `?peek=<id>` | **Pending** |
| Business Transaction (JE quick-post) | `BusinessTransactionDialog` | Route + `RecordFormShell` at `/finance/journal-entries/new?template=business` | **Pending** |
| Recurring Journal | `RecurringJournalDialog` | Route + `RecordFormShell` at `/finance/recurring-journals/new` + `/:id/edit` + `PeekScaffold` | **Pending** |
| Chart of Accounts entry | Create / Edit | inline form | Route + `RecordFormShell` at `/finance/accounts/new` + `/:id/edit` | **Pending** |
| Fiscal Period | Create / Edit | inline dialog | `DetailSheet` (≤6 fields) | **Pending** |
| Year-End Close | `YearEndClosingDialog` | `WizardShell` at `/finance/fiscal-periods/close` | **Pending** |
| Budget | Create / Edit | inline dialog | Route + `RecordFormShell` at `/finance/budgets/new` + `/:id/edit` (line grid for account budgets) | **Pending** |
| Fixed Asset | Create / Edit | inline dialog | Route + `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit` | **Pending** |
| Fixed Asset | Peek | inline dialog | `PeekScaffold` | **Pending** |
| Analytic Account | Create / Edit | inline form | `DetailSheet` | **Pending** |
| Bank Account | Connect | `ConnectBankDialog` | Route + `RecordFormShell` at `/finance/banking/accounts/new` | **Pending** |
| Bank Account | Edit | `EditBankAccountDialog` | Route + `RecordFormShell` at `/finance/banking/accounts/:id/edit` | **Pending** |
| Bank Reconciliation | Start | `StartReconciliationDialog` | Route + `WizardShell` at `/finance/reconciliation/new` | **Pending** |
| Bank Reconciliation | Workspace | `ReconcileTransactionDialog` (row-by-row) | Route + `RecordScaffold` split-view at `/finance/reconciliation/:id` (row edit inline in the workspace) | **Pending** |
| Bank Transfer Reconcile | `TransferReconcileDialog` | Step inside the reconciliation workspace `WizardShell` | **Pending** |
| Bank Transactions Import | `ImportTransactionsDialog` | `WizardShell` at `/finance/banking/:id/import` | **Pending** |
| Transaction Matching Rules | `TransactionRulesDialog` | Route + `RecordScaffold` at `/finance/banking/rules` + `RecordFormShell` for new/edit | **Pending** |
| Customer Credit — Apply | `ApplyCreditDialog` | `WizardShell` at `/finance/customer-credits/:id/apply` | **Pending** |
| Customer Credit — Refund | `ProcessRefundDialog` | `WizardShell` at `/finance/customer-credits/:id/refund` | **Pending** |
| Default Account Mappings — Apply | `ApplyDefaultMappingsDialog` | `Dialog` (allowed — confirm-style) | Done |
| Credit Note (legacy finance surface) | `CreditNoteDetailDialog` | Delete — superseded by Sales `/sales/credit-notes/:id` + peek | **Pending** |

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
