## Assessment of prior work

Sales, Purchases, and Inventory ledgers are at 0 pending — spot-checks confirm the guards enforce empty/frozen allowlists and the record scaffolds are in place. Those three apps are genuinely done.

Finance is partly done. Verified against the codebase (not the ledger, not agent claims):

**Actually complete**
- Journal Entries — create/edit routes, detail page, `?peek=` sheet ✅
- Business Transactions — create route ✅
- Recurring Journals — create route ✅
- Chart of Accounts — `AccountCreatePage` + `AccountEditPage` + `AccountForm` exist (ledger still says Pending — stale)
- Year-End Close — `/finance/year-end-close` page exists; `YearEndClosingDialog` deleted
- Fiscal Periods — `ClosePeriodSheet` + `GeneratePeriodsSheet` (DetailSheet target, matches)
- Analytic Accounts — `AnalyticAccountSheet` + `AnalyticGroupSheet` (DetailSheet target, matches)
- `ApplyDefaultMappingsDialog` — allowed confirm-style ✅

**Deviation from ledger** — the previous agent used `Sheet` where the ledger specified full-page routes. These record surfaces are substantial and the platform standard in `mem://index.md` is unambiguous: *every create/edit for a business record is a `/new` or `/:id/edit` route on `RecordFormShell`*. The sheets need promotion to routes:
- `BankAccountSheet` (1107 lines) → `/finance/banking/accounts/new` + `/:id/edit`
- `BudgetFormSheet` / `BudgetItemSheet` / `CopyBudgetSheet` / `ManageBudgetSheet` → `/finance/budgets/new` + `/:id/edit` with line grid
- `AssetFormSheet` (+ Category / Dispose / DepreciationRun) → `/finance/fixed-assets/new` + `/:id/edit`
- `AssetDetailSheet` → `PeekScaffold` at `?peek=<id>`

**Legacy dialogs still present** (8 files under the ban regex or ledger scope):
```
src/components/banking/StartReconciliationDialog.tsx
src/components/banking/ReconcileTransactionDialog.tsx
src/components/banking/TransferReconcileDialog.tsx
src/components/banking/ImportTransactionsDialog.tsx
src/components/banking/TransactionRulesDialog.tsx
src/components/finance/ApplyCreditDialog.tsx
src/components/finance/ProcessRefundDialog.tsx
src/components/finance/CreditNoteDetailDialog.tsx   (delete — superseded by Sales)
```

The finance ledger shows 17 Pending rows; the true remaining scope is 12 migrations + 1 deletion + audit reconciliation.

## Plan

Work in the order below. Each step ships routes/scaffolds, deletes the legacy file, shrinks the guard allowlist where applicable, updates the audit ledger, and runs `tsgo` + the four dialog-ban tests.

### Step 1 — Reconcile ledger with reality (no code changes)
Update `docs/design-system/audit/finance.md`:
- Mark Chart of Accounts create/edit **Done** (routes exist).
- Mark Year-End Close **Done** (page exists, dialog deleted).
- Add a "Deviation" note for Bank Account / Budget / Fixed Asset explaining the sheet-first landing and the follow-up to promote to routes (tracked by Steps 3–5).

### Step 2 — Banking workflows (5 dialogs → routes/wizards)
```text
StartReconciliationDialog   → /finance/reconciliation/new                (WizardShell)
ReconcileTransactionDialog  → /finance/reconciliation/:id                (RecordScaffold split-view; row edit inline)
TransferReconcileDialog     → step inside the reconciliation workspace   (no standalone surface)
ImportTransactionsDialog    → /finance/banking/:id/import                (WizardShell: upload → map → preview → post)
TransactionRulesDialog      → /finance/banking/rules  +  /rules/new  +  /rules/:id/edit
                              (RecordScaffold list + RecordFormShell)
```
For each: build routes, port hooks/mutations 1:1, replace call-sites, `rm` the dialog, verify guards.

### Step 3 — Customer credit wizards (2 dialogs → routes)
```text
ApplyCreditDialog    → /finance/customer-credits/:id/apply    (WizardShell)
ProcessRefundDialog  → /finance/customer-credits/:id/refund   (WizardShell)
```
Same migration recipe; delete dialogs when call-sites are gone.

### Step 4 — Bank Account: promote sheet → route
- Create `/finance/banking/accounts/new` and `/finance/banking/accounts/:id/edit` on `RecordFormShell`, backed by a shared `BankAccountForm` factored out of `BankAccountSheet`.
- Update Banking list + `BankAccountCard` to navigate instead of opening the sheet.
- Remove `BankAccountSheet` and the `?sheet=account` param handling.

### Step 5 — Budget: promote sheets → routes
- `/finance/budgets/new` and `/:id/edit` on `RecordFormShell` with the line grid for account budgets.
- Absorb `BudgetItemSheet` into the line grid, keep `CopyBudgetSheet` as a `DetailSheet` action (small config), keep `ManageBudgetSheet` only if it hosts allocation editing — otherwise fold into the object page.
- Update Budgets list to navigate; remove the promoted sheets.

### Step 6 — Fixed Asset: promote sheets → routes + peek
- `/finance/fixed-assets/new` + `/:id/edit` on `RecordFormShell` (from `AssetFormSheet`).
- `?peek=<id>` `PeekScaffold` from `AssetDetailSheet`.
- Keep `AssetCategorySheet` (small config, DetailSheet target OK), `DepreciationRunSheet` and `DisposeAssetSheet` as `WizardShell` steps or DetailSheets depending on field count.

### Step 7 — Delete `CreditNoteDetailDialog`
The Sales credit-note record page + peek supersedes it. Rewrite any remaining call-sites to route to `/sales/credit-notes/:id` (or open the peek), then `rm` the file.

### Step 8 — Freeze the guard + close the ledger
- Shrink `LEGACY_DIALOG_ALLOWLIST` in `src/test/architecture/finance-record-dialog-ban.test.ts` to `[]` (currently allows only `CreditNoteDetailDialog.tsx`, which Step 7 removes).
- Ledger: every row → **Done** (or **Deleted**); update `mem://index.md` core rule to note the finance allowlist is now frozen empty.
- Verify: `bunx vitest run src/test/architecture` (all four dialog-ban tests) + `tsgo`.

## Technical notes

- All new routes go under `src/routes/finance/…` as TanStack Start file-based routes; feature code lives in `src/features/finance/<area>/`.
- Reuse `useRecordFormSubmit`, `FieldGrid`, `SummaryPanel`, `WizardShell`, `RecordScaffold`, `PeekScaffold`, `LineItemsGrid` from `@/design-system` — no new primitives are needed.
- Hooks and mutations are already parameterised inside the dialogs; migrations lift the JSX into a route component and swap the trigger for a `<Link>`/`navigate()`.
- Keep RLS / permissions untouched — this is a presentation refactor.
- After each step: `rg` for the deleted symbol to prove no orphan imports; run the corresponding dialog-ban test.

## Out of scope

- Business-logic changes (RPCs, RLS, mutations) — pure UI/UX migration.
- Sales / Purchases / Inventory — already at 0 pending and verified.
