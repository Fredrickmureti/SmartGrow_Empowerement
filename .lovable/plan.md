## Verified status

I independently reverified the prior agent's claims against the code:

- **Sales / Purchases / Inventory** — audit docs marked complete; guard tests green; allowlists empty. No outstanding work.
- **Finance** — Journal Entry **Create** and **Edit** are now on `RecordFormShell` at `/finance/journal-entries/new` and `/:id/edit` (audit doc flipped to Done, files exist). The finance dialog-ban guard is green because it only enforces `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` filename patterns — the twelve remaining legacy dialogs use different filenames (`BusinessTransactionDialog`, `RecurringJournalDialog`, `YearEndClosingDialog`, `ConnectBank…`, `Reconcile…`, `ImportTransactions…`, `TransactionRules…`, `ApplyCreditDialog`, `ProcessRefundDialog`, `CreditNoteDetailDialog`, `EditBankAccountDialog`) and are tracked only by the audit doc.
- **Typecheck** — clean.

The prior agent's next‑slice notes match the actual audit gap. Pick up from Journal Entry Peek/View and finish Finance.

## Plan — Finish Finance (single slice at a time)

Reuse existing design‑system scaffolds only: `RecordFormShell`, `RecordScaffold`, `PeekScaffold` / `DocumentPeekShell`, `DetailSheet`, `WizardShell`, `LineItemsGrid`, `SummaryPanel`, `DocumentTotalsPanel`, `DocumentActivityPanel`, `useRecordFormSubmit`. No new primitives.

For every entity: build route(s) → migrate the call site → delete the legacy dialog file → flip the audit row → keep guard test green.

### Slice B1 — Journal Entry View + Peek
- `RecordScaffold` at `/finance/journal-entries/:id` (identity, meta chips, line grid read‑only, totals + activity + attachments in `SummaryPanel`).
- `JournalEntryPeekSheet` on `PeekScaffold` behind `?peek=<id>` on the list.
- Remove `JournalEntryDetailRedirect` inline hop; redirect stays for back‑compat URLs pointing to `?selected=` if any external links exist.

### Slice B2 — Business Transaction + Recurring Journal
- `BusinessTransactionDialog` → deep‑link `/finance/journal-entries/new?template=business` on the same JE `RecordFormShell` (template pre‑fills lines). Delete dialog.
- `RecurringJournalDialog` → `/finance/recurring-journals/new` + `/:id/edit` on `RecordFormShell` with `LineItemsGrid`; `PeekScaffold` for the list. Delete dialog.

### Slice B3 — Chart of Accounts + Analytic Accounts + Fiscal Periods
- CoA: `RecordFormShell` at `/finance/accounts/new` and `/:id/edit` (identity, type, parent, currency, tax mapping, opening balance).
- Analytic Accounts: `DetailSheet` (≤6 fields).
- Fiscal Periods: `DetailSheet` create/edit.
- Year‑End Close: `WizardShell` at `/finance/fiscal-periods/close` (Scope → Adjustments preview → Post & lock). Delete `YearEndClosingDialog`.

### Slice B4 — Budgets + Fixed Assets
- Budgets: `RecordFormShell` at `/finance/budgets/new` + `/:id/edit` with `LineItemsGrid` for account × period.
- Fixed Assets: `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit`; `PeekScaffold` for the list.

### Slice B5 — Banking (highest risk)
- `ConnectBankDialog` → `RecordFormShell` at `/finance/banking/accounts/new`.
- `EditBankAccountDialog` → `RecordFormShell` at `/finance/banking/accounts/:id/edit` (also drops it off the filename allowlist).
- Reconciliation workspace: `WizardShell` at `/finance/reconciliation/new` and split‑view `RecordScaffold` at `/finance/reconciliation/:id` — replaces `StartReconciliationDialog`, `ReconcileTransactionDialog`, `TransferReconcileDialog` (transfer becomes an inline workspace step). Build the workspace scaffold first, then port each dialog as a region/step.
- `ImportTransactionsDialog` → `WizardShell` at `/finance/banking/:id/import` (Upload → Map columns → Preview → Commit).
- `TransactionRulesDialog` → `RecordScaffold` at `/finance/banking/rules` + `RecordFormShell` for new/edit.

### Slice B6 — Customer Credits + Legacy cleanup
- `ApplyCreditDialog` → `WizardShell` at `/finance/customer-credits/:id/apply`.
- `ProcessRefundDialog` → `WizardShell` at `/finance/customer-credits/:id/refund`.
- Delete `CreditNoteDetailDialog`; repoint any remaining consumers to the Sales `/sales/credit-notes/:id` + peek that already exist.

### Slice B7 — Guard + integrity pass
- Extend `finance-record-dialog-ban.test.ts` with an inline‑`<Dialog>` scan for Finance list pages (mirrors the Inventory guard's second section) so regressions on non‑filename‑matching dialogs are also blocked.
- Empty the filename allowlist entirely (both `CreditNoteDetailDialog` and `EditBankAccountDialog` are deleted by then).
- Grep for lingering `import …Dialog` references to deleted files; fix.
- Verify deep‑links (`?action=create`, `?peek=<id>`, dashboard/notification/command‑palette inbound) resolve to the new routes.
- Run `bunx tsgo --noEmit` + full architecture test suite; both must be green before closing the slice.

### Ground rules

- One entity per turn: route(s) → callsite migration → delete legacy dialog → flip audit row → guard green.
- Preserve every existing RPC call, RLS‑scoped query, branch/business scoping, and toast wording verbatim — UX/architecture migration only, no business‑logic change.
- No reach‑through into `@/features/sales/record/*` from Finance; import scaffolds from `@/design-system` only.
- Do not touch Sales / Purchases / Inventory — those apps are already complete per their audit docs and guard tests.

Ping me to switch to build mode and I'll start with **Slice B1 — Journal Entry View + Peek**.
