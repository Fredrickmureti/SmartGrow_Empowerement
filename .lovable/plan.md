# Finance Slice B5 — Banking & Payment Recording

## Context

Slices B1–B4 landed the enterprise interaction model across Journal Entries, Chart of Accounts, Analytic Accounts, Fiscal Periods, Year-End Close, Budgets, and Fixed Assets. Every routed create/edit now composes `RecordFormShell` / `DetailSheet` / `WizardShell` from `@/design-system`, and lists open records through URL-driven sheets.

The **Banking** and **AR/AP Payment Recording** surfaces are the last significant clusters of legacy `<Dialog>` interactions inside Finance. They currently host substantive business workflows (connecting a bank, importing a statement, reconciling a transaction, recording an invoice or bill payment) in narrow modal dialogs that break the platform's interaction language and lose context every time the user opens one.

This slice migrates all of them, in the exact order below, verifying each entity before moving on. No business-logic changes — only interaction architecture, URL wiring, and layout composition against existing design-system primitives.

## Scope (one entity at a time, verified before moving on)

### 1. Banking — accounts & connection
Files today: `src/components/banking/ConnectBankDialog.tsx`, `EditBankAccountDialog.tsx`.

- New `src/features/finance/banking/BankAccountSheet.tsx` — single `DetailSheet` composed on `FieldGrid` handling both **connect** (create) and **edit** modes for a bank account (name, currency, GL account, opening balance, provider metadata). Uses `useRecordFormSubmit`.
- Edit `src/pages/Banking.tsx` (or the equivalent list page that mounts these dialogs) to drop both `<Dialog>` blocks and mount the sheet behind `?sheet=account[&id=<uuid>]`.
- Delete `ConnectBankDialog.tsx` and `EditBankAccountDialog.tsx` in the same commit that removes their last import.

### 2. Banking — statement import
File today: `src/components/banking/ImportTransactionsDialog.tsx` (upload CSV/OFX → column mapping → preview → commit).

- New `src/features/finance/banking/ImportStatementWizard.tsx` at route `/finance/banking/:accountId/import` composed on `WizardShell` with steps: **Upload → Map columns → Review → Commit**. Lifts the parse/preview/commit handlers verbatim out of the dialog into step handlers.
- Register the route in `src/apps/finance/routes.tsx` under the same `SubscriptionProtectedRoute` as the rest of banking.
- Replace the dialog trigger in Banking with a `<Link>` to the wizard route.
- Delete `ImportTransactionsDialog.tsx`.

### 3. Banking — reconciliation
Files today: `StartReconciliationDialog.tsx`, `ReconcileTransactionDialog.tsx`, `TransferReconcileDialog.tsx`, `TransactionRulesDialog.tsx`.

- `StartReconciliationDialog` → `DetailSheet` (`?sheet=start-reconcile`) in a new `src/features/finance/banking/reconciliation/StartReconciliationSheet.tsx` — 4 fields (statement date, opening balance, closing balance, note), pure configuration.
- `ReconcileTransactionDialog` and `TransferReconcileDialog` are per-row matching surfaces → convert to a single `ReconcileMatchSheet` opened from the reconciliation workspace with `?match=<txnId>`; the sheet renders the candidate list, split lines, and posts the same RPC. Preserves context (statement stays visible behind the sheet) instead of stacking modals.
- `TransactionRulesDialog` (recurring rules editor) is a small config surface → `DetailSheet` behind `?sheet=rules`.
- Delete all four legacy dialogs.

### 4. Invoice payment recording (AR)
Files today: `src/components/invoices/RecordPaymentDialog.tsx`, `PaymentHistoryDialog.tsx`, `BulkExportDialog.tsx`, `BulkDeleteDialog.tsx`.

- `RecordPaymentDialog` (allocations against outstanding invoices, currency, method, reference) → `DetailSheet` at `?sheet=payment&invoiceId=<uuid>` in `src/features/finance/receivables/RecordInvoicePaymentSheet.tsx`. Same allocation grid, `useRecordFormSubmit`, same RPCs.
- `PaymentHistoryDialog` → `DetailSheet` (read-only) behind `?sheet=payment-history&invoiceId=<uuid>` — payment timeline stays in-context, no popup.
- `BulkExportDialog` / `BulkDeleteDialog` stay as `<Dialog>` **only** if they're pure confirms (≤2 fields). If either has real form state (format, date range, dry-run toggle), it moves to a `DetailSheet` under the same convention. Verified per file at edit time.
- Mount all sheets from the invoices list page (`src/pages/Invoices.tsx` or equivalent) and the invoice record page so both entry points share the same URL contract.

### 5. Bill payment recording (AP)
Files today: `src/components/bills/RecordBillPaymentDialog.tsx`, `BillPaymentHistoryDialog.tsx`.

- Mirror the AR pattern exactly: `RecordBillPaymentSheet.tsx` + `BillPaymentHistorySheet.tsx` under `src/features/finance/payables/`. Same URL contract (`?sheet=payment|payment-history&billId=<uuid>`), same allocation grid pattern.

### 6. Budget vs Actual analytics
File today: `src/components/budgets/BudgetVsActualDialog.tsx`.

- Substantial analytical surface (variance table, filters, drill-down) → this is not a dialog. Promote to a routed page `/finance/budgets/:id/vs-actual` composed on `RecordShell` (report layout, no form). Replace the trigger with a `<Link>`.
- Delete the dialog.

## Reusable primitives (extract only if a second consumer appears in this slice)

Do not preemptively extract. Watch for these shapes as the slice lands and lift into `@/design-system/records` **only** if used by ≥2 modules within this slice:

- **AllocationGrid** — invoice/bill payment allocation table (amount, outstanding, allocated). Both AR and AP will need it → extract on the second consumer.
- **StatementColumnMapper** — CSV column → canonical field mapping row list. Single consumer this slice → keep local.

Everything else composes from the existing primitives already exported from `@/design-system` (`DetailSheet`, `RecordFormShell`, `WizardShell`, `FieldGrid`, `FooterActionBar`, `SummaryPanel`, `useRecordFormSubmit`).

## Guardrails / verification (must pass before closing the slice)

- `rg "<Dialog\b" src/components/banking src/components/invoices src/components/bills src/components/budgets` → zero hits.
- `rg "ConnectBankDialog|EditBankAccountDialog|ImportTransactionsDialog|StartReconciliationDialog|ReconcileTransactionDialog|TransferReconcileDialog|TransactionRulesDialog|RecordPaymentDialog|PaymentHistoryDialog|RecordBillPaymentDialog|BillPaymentHistoryDialog|BudgetVsActualDialog"` → zero hits outside git history.
- Every new sheet is URL-driven (`?sheet=…`), survives refresh, and closes on browser back.
- Preserve branch/business scoping and RLS on every query and mutation. Do not touch `useInvoices`, `useBills`, `useBankAccounts`, `useBankTransactions`, or the reconciliation RPCs.
- No new `<Dialog>` JSX added anywhere except `ConfirmDeleteDialog` invocations.
- `bunx tsgo --noEmit` clean; existing finance dialog-ban guard test stays green.

## Out of scope (deferred to later slices)

- **B6** — Customer Statements, Vendor Statements, Recurring Invoices, Credit Notes, Vendor Credit Notes (each still hosts inline dialogs; own slice because they share statement-generation infra).
- **B7** — Extend the finance dialog-ban ESLint/pgTAP-style guard to scan **inline `<Dialog>` JSX**, not just filenames, so future regressions fail at CI.
- **Sales**, **Purchases**, **Inventory** — separate top-level tracks handled after Finance is fully converged.
- Any change to underlying RPCs, RLS policies, or data models.

## Technical notes

- URL-driven sheets use `useSearchParams` (already the pattern in Sales/Purchases peek sheets and prior Finance slices). Never React-state-only.
- Wizard step state stays local to the wizard; only the final commit hits the network. Preview steps reuse the same read-only helpers the current dialogs call.
- Delete each legacy dialog file in the same commit that removes its last import — keeps the filename guard clean and prevents dead-code drift.
- Do not import from `@/features/sales/*` or `@/features/purchases/*`. Only `@/design-system`.
- Match the composition and density of the HR/Payroll and prior Finance slice sheets exactly — same header layout, same `FieldGrid` column counts, same `FooterActionBar` action ordering.
