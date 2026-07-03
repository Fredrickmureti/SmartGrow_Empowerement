## Independent assessment

I verified the previous agent's work against the actual tree, not the ledger prose.

**Sales, Purchases, Inventory — genuinely complete.** Their ledgers under `docs/design-system/audit/` show zero `Pending` / `Deviation` rows, the `*-record-dialog-ban` architecture tests exist for all three, and no `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` remain in those surfaces. No rework needed.

**Finance — the ledger is honest; the previous agent stopped exactly where it says.** Verified against the filesystem:

- Still present (need promotion): `src/components/banking/ReconcileTransactionDialog.tsx` (498 LOC), `TransferReconcileDialog.tsx` (152), `src/features/finance/banking/BankAccountSheet.tsx` (1107), `src/features/finance/budgets/{BudgetFormSheet,BudgetItemSheet,ManageBudgetSheet}.tsx` (794 total).
- Already migrated and verified: Journal Entry, Business Transaction, Recurring Journal, CoA, Fiscal Period, Year-End Close, Analytic Account, Start Reconciliation, Import Statement (wave 3), Transaction Rules (wave 4), Apply Credit (wave 5), Process Refund (wave 6), Fixed Assets (form + peek). All these have corresponding routes and their legacy dialog files are gone.
- Guard `finance-record-dialog-ban` exists but its regex only catches `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` filenames — verb-noun dialogs (`ReconcileTransactionDialog`) and `*Sheet.tsx` files pass through. That's what "shrink-only" hides in the memory core; it must be tightened once the remaining files are gone.

Nothing above is architecturally wrong — the prior work is production-quality and I will not redo it. The plan below picks up at wave 1.

## Remaining work — Finance only

```text
Wave 1+2  Reconciliation workspace (inline ReconcileTransactionDialog + TransferReconcileDialog)
Wave 7    BankAccountSheet → /finance/banking/accounts/new  +  /:id/edit
Wave 8    Budgets (3 sheets) → /finance/budgets/new  +  /:id/edit  (with line grid)
Wave 11   Tighten guard + freeze memory
```

### Wave 1+2 — Reconciliation workspace (split-view `RecordScaffold`)

- Promote `src/components/banking/ReconciliationWorkspace.tsx` into a proper `RecordScaffold` split-view at `/finance/reconciliation/:id`: transaction list left, side rail right with the currently-selected txn.
- Fold `ReconcileTransactionDialog`'s match / create-JE / split behaviour into the side rail as inline forms (no modal).
- Fold `TransferReconcileDialog` into the same rail as a "Match as transfer" mode when the selected txn's counterpart lives on another bank account.
- Port validation, RPC calls (`reconcile_transaction`, `create_bank_transfer_reconcile`), toast copy, permission gates, unbalanced-line guards verbatim.
- Rewire `BankReconciliation.tsx` to open the workspace via route; delete both dialogs.

### Wave 7 — Bank Account (largest single file)

- New route `/finance/banking/accounts/new` and `/finance/banking/accounts/:id/edit` composed on `RecordFormShell`.
- Split `BankAccountSheet` into: (a) shared `useBankAccountForm` hook, (b) `BankAccountCreatePage` with manual / connect-provider tabs as `RecordFormShell` sections, (c) `BankAccountEditPage` (no provider tabs), (d) shared `useProviderConnectHandoff` hook for OAuth.
- Rewire `Banking.tsx`, `BankFeeds.tsx`, `ContactProfile.tsx`, `banking-ownership.test.ts`, `src/lib/bankAccountTypes.ts` consumers to the new routes; delete `BankAccountSheet.tsx`.

### Wave 8 — Budgets

- New routes `/finance/budgets/new` and `/finance/budgets/:id/edit` on `RecordFormShell`.
- Header fields (name, fiscal period, scope) as a section; account-budget lines as `LineItemsGrid` embedded on the edit page — replaces the sheet-inside-sheet nesting.
- Preserve `CopyBudgetSheet` if it's a genuine ≤6-field `DetailSheet` (verify against the standard); otherwise route it too.
- Rewire `Budgets.tsx` to `navigate(...)` for create/edit and open the line grid inline; delete `BudgetFormSheet`, `BudgetItemSheet`, `ManageBudgetSheet`.

### Wave 11 — Guard tightening + memory freeze

- Broaden `src/test/architecture/finance-record-dialog-ban.test.ts` to match any `*Dialog.tsx` under `src/components/{finance,banking,accounting}` and any `*Sheet.tsx` under `src/features/finance/**` with empty allowlists (after waves 1/2/7/8 land there is nothing left to allow).
- Flip the `finance` line in the memory core from "shrink-only" to "frozen (empty allowlist)".
- Update `docs/design-system/audit/finance.md`: flip the four remaining rows (Reconciliation Workspace, Bank Transfer Reconcile, Bank Account, Budget) to **Done** with the new file paths; drop the "Deviation" markers.

## Per-wave verification

For every wave, before moving on:

1. `bunx tsgo -p tsconfig.app.json --noEmit`
2. `bunx vitest run src/test/architecture/finance-record-dialog-ban.test.ts src/test/architecture/banking-ownership.test.ts`
3. `rg <deleted-basename> src/` returns empty.
4. Playwright smoke on the new route (open → submit → assert list refresh).

## Definition of done

- Zero `Dialog` / `Sheet` files remain for any of the four surfaces above.
- `finance.md` shows every row **Done**; no `Pending` / `Deviation` markers.
- Guard broadened to `*Dialog.tsx` + `*Sheet.tsx` with empty allowlists.
- Memory core says the Finance guard is frozen.
- `tsgo` clean; every architecture test green.

I'll take waves in this order and ping between waves: **1+2 → 7 → 8 → 11**. No Sales / Purchases / Inventory rework — those are verified complete.
