## Where the previous agent actually stopped

Verified against the codebase, not agent notes:

- **Done:** `src/features/finance/banking/BankAccountEditSheet.tsx` exists, is URL-driven (`?sheet=account&id=<uuid>`), mounted in `src/pages/Banking.tsx`, and `EditBankAccountDialog.tsx` is deleted. Architecture guard `banking-ownership.test.ts` references the new sheet.
- **Not done — still legacy `<Dialog>` in the tree:** `ConnectBankDialog`, `ImportTransactionsDialog`, `StartReconciliationDialog`, `ReconcileTransactionDialog`, `TransferReconcileDialog`, `TransactionRulesDialog`, `RecordPaymentDialog` (invoices), `PaymentHistoryDialog` (invoices), `RecordBillPaymentDialog`, `BillPaymentHistoryDialog`, `BudgetVsActualDialog`. All still imported from their respective pages.
- Plan file `.lovable/plan.md` (Slice B5) is still the correct spec. No revision needed to scope — only execution remains.

Everything downstream in the mega-prompt (Sales, Purchases, Inventory tracks; B6 statements/credit notes; B7 inline-`<Dialog>` guard) stays out of scope until Finance B5 closes, per the "complete one application before moving on" rule in the original brief.

## Execution plan (resume, one entity at a time, verify between each)

### Step 1b — Finish Banking accounts: fold Connect into `BankAccountSheet`
- Rename `BankAccountEditSheet.tsx` → `BankAccountSheet.tsx`; add a `mode: "connect" | "edit"` branch (create path currently in `ConnectBankDialog` — name, currency, GL account, opening balance, provider metadata) reusing the existing `FieldGrid` + `useRecordFormSubmit` composition.
- URL contract: `?sheet=account` (connect) and `?sheet=account&id=<uuid>` (edit). Both open the same sheet, submit through the same handler shape.
- Update `src/pages/Banking.tsx`: drop `<ConnectBankDialog>`, replace trigger with a link/button that sets `?sheet=account`. Delete `src/components/banking/ConnectBankDialog.tsx` in the same change. Update `src/lib/bankAccountTypes.ts` doc comment.
- Verify: `rg "ConnectBankDialog|EditBankAccountDialog" src/` → 0 hits; `bunx tsgo --noEmit` clean; `banking-ownership` guard green.

### Step 2 — Banking statement import wizard
- New route `src/routes/finance.banking.$accountId.import.tsx` (file-based) → `WizardShell` steps **Upload → Map columns → Review → Commit**. Lift parse/preview/commit handlers verbatim from `ImportTransactionsDialog`. Keep the CSV column mapper local (single consumer, per plan).
- Register under the same subscription/branch guard used by other finance routes (mirror `journal-entries` route wiring).
- Replace the dialog trigger in `Banking.tsx` / `BankFeeds.tsx` with `<Link to="/finance/banking/$accountId/import" params={{ accountId }}>`.
- Delete `ImportTransactionsDialog.tsx`. Verify no stale imports.

### Step 3 — Banking reconciliation sheets
- `StartReconciliationDialog` → `StartReconciliationSheet.tsx` behind `?sheet=start-reconcile` (`DetailSheet`, 4 fields).
- Merge `ReconcileTransactionDialog` + `TransferReconcileDialog` into one `ReconcileMatchSheet.tsx` opened from `ReconciliationWorkspace.tsx` with `?match=<txnId>&kind=txn|transfer`. Preserves the workspace behind the sheet instead of stacking modals. Same matching/split RPCs.
- `TransactionRulesDialog` → `TransactionRulesSheet.tsx` behind `?sheet=rules`.
- All four legacy files deleted in the same commit that removes their last import. Rerun `banking-ownership` guard.

### Step 4 — AR payment recording sheets
- `RecordInvoicePaymentSheet.tsx` at `src/features/finance/receivables/` behind `?sheet=payment&invoiceId=<uuid>`. Same allocation grid, currency, method, reference; `useRecordFormSubmit`; same RPCs.
- `InvoicePaymentHistorySheet.tsx` (read-only) behind `?sheet=payment-history&invoiceId=<uuid>`.
- Audit `BulkExportDialog` and `BulkDeleteDialog` per plan §4: keep as `<Dialog>` only if ≤2 fields / pure confirm; otherwise promote to sheet. Decide per file at edit time and record the call in the file header.
- Mount from both `src/pages/Invoices.tsx` and the invoice record page so both entry points share the URL contract. Also fold `src/pages/CustomerPayments.tsx` and `src/pages/sales/Collections.tsx` triggers onto the same sheet URL.
- Delete `RecordPaymentDialog.tsx` + `PaymentHistoryDialog.tsx` under `src/components/invoices/`. `src/components/sales/RecordPaymentDialog.tsx` is a separate legacy path — audit and either point it at the new sheet or delete if unused.

### Step 5 — AP payment recording sheets
- Mirror Step 4 exactly under `src/features/finance/payables/`: `RecordBillPaymentSheet.tsx`, `BillPaymentHistorySheet.tsx`. Same URL contract with `billId`. Mounted from `src/pages/Bills.tsx` and `src/pages/finance/AccountsPayable.tsx`.
- **Extraction trigger:** at this point AR + AP both use the allocation table → lift `AllocationGrid` into `@/design-system/records/AllocationGrid` and refactor both sheets to consume it (plan §"Reusable primitives" — extract on second consumer only).
- Delete `RecordBillPaymentDialog.tsx` + `BillPaymentHistoryDialog.tsx`.

### Step 6 — Budget vs Actual → routed report page
- New route `src/routes/finance.budgets.$id.vs-actual.tsx` composed on `RecordShell` (report layout, no form). Lift variance table, filters, drill-down verbatim from `BudgetVsActualDialog.tsx`.
- Replace triggers in the budgets list/detail with `<Link>`. Delete the dialog.

### Slice-close verification (must all pass before declaring B5 done)
- `rg "<Dialog\b" src/components/banking src/components/invoices src/components/bills src/components/budgets` → 0 hits.
- `rg "ConnectBankDialog|EditBankAccountDialog|ImportTransactionsDialog|StartReconciliationDialog|ReconcileTransactionDialog|TransferReconcileDialog|TransactionRulesDialog|RecordPaymentDialog|PaymentHistoryDialog|RecordBillPaymentDialog|BillPaymentHistoryDialog|BudgetVsActualDialog" src/` → 0 hits.
- Every new sheet URL-driven, survives refresh, closes on browser back.
- `bunx tsgo --noEmit` clean. Existing finance dialog-ban filename guard + `banking-ownership` guard + `payment-reversal-intent-contract` guard all green.
- No changes to `useInvoices`, `useBills`, `useBankAccounts`, `useBankTransactions`, reconciliation RPCs, RLS, or data models. Branch/business scoping preserved on every query and mutation.

### Technical notes
- All sheets use `useSearchParams` (matches Sales/Purchases peek pattern and prior Finance slices). Never React-state-only visibility.
- Wizard step state local; only the commit step hits the network. Preview steps reuse the read-only helpers the dialogs currently call.
- Only import design primitives from `@/design-system`. Do not cross-import from `@/features/sales/*` or `@/features/purchases/*`.
- Match composition/density of prior slice sheets exactly: same header, same `FieldGrid` column counts, same `FooterActionBar` action ordering.

### Deferred (unchanged from plan file)
- **B6:** Customer/Vendor Statements, Recurring Invoices, Credit Notes, Vendor Credit Notes.
- **B7:** Extend dialog-ban guard to detect inline `<Dialog>` JSX, not just filenames.
- **Sales / Purchases / Inventory** tracks: separate top-level initiatives after Finance fully converges.
