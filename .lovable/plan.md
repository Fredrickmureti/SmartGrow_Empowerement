## Assessment of prior work

I audited the four in-scope apps against the enterprise-UX ledgers under `docs/design-system/audit/` and verified every "Done" claim against the code.

**Sales · Purchases · Inventory — verified complete.**
Every entity in those three ledgers is on `RecordFormShell` (`/new` + `/:id/edit`), `RecordScaffold` (object page), or `PeekScaffold` (`?peek=<id>`). Architecture guards (`sales-record-dialog-ban`, `purchases-record-dialog-ban`, `inventory-record-dialog-ban`) are wired and their legacy allowlists are empty or shrink-only. No `Create*Dialog` / `Edit*Dialog` / `*DetailDialog` files remain in those surfaces.

**Finance — partially complete. Previous agent stopped mid-migration.**
Journal Entry, Business Transaction, Recurring Journal, CoA, Fiscal Period, Year-End Close, Analytic Account, Reconciliation-start, and legacy Credit Note surfaces are all migrated. `StartReconciliationPage` and its route (`/finance/reconciliation/new`) are landed as claimed. The `finance-record-dialog-ban` guard exists but its regex only matches `Create*/Edit*/*DetailDialog` filenames, so the remaining dialogs (which use verb-noun names) are not caught by the guard even though they violate the standard. **The ledger correctly lists them as Pending / Deviation — the guard is the loose part, not the ledger.**

### Remaining Finance work (verified against the tree)

| # | Surface | File(s) | LOC | Target |
| - | - | - | - | - |
| 1 | Reconcile transaction (row match) | `src/components/banking/ReconcileTransactionDialog.tsx` | 498 | Inline into the reconciliation workspace `RecordScaffold` at `/finance/reconciliation/:id` (split-view; row-edit inline) |
| 2 | Bank transfer reconcile | `src/components/banking/TransferReconcileDialog.tsx` | 152 | Step inside the same reconciliation workspace |
| 3 | Bank transactions import | `src/components/banking/ImportTransactionsDialog.tsx` | 670 | `WizardShell` at `/finance/banking/:id/import` (Upload → Map columns → Preview → Commit) |
| 4 | Transaction matching rules | `src/components/banking/TransactionRulesDialog.tsx` | 551 | `RecordScaffold` list at `/finance/banking/rules` + `RecordFormShell` at `/finance/banking/rules/new` and `/:id/edit` |
| 5 | Apply customer credit | `src/components/finance/ApplyCreditDialog.tsx` | 221 | `WizardShell` at `/finance/customer-credits/:id/apply` (Select invoices → Allocate → Confirm) |
| 6 | Process credit refund | `src/components/finance/ProcessRefundDialog.tsx` | 219 | `WizardShell` at `/finance/customer-credits/:id/refund` (Amount + method → Confirm) |
| 7 | Bank account connect/edit | `src/features/finance/banking/BankAccountSheet.tsx` | 1107 | `RecordFormShell` at `/finance/banking/accounts/new` + `/:id/edit` |
| 8 | Budget create/edit + lines | `BudgetFormSheet` + `BudgetItemSheet` + `ManageBudgetSheet` | 794 | `RecordFormShell` at `/finance/budgets/new` + `/:id/edit` with a line grid; delete the three sheets |
| 9 | Fixed asset create/edit | `src/features/finance/fixed-assets/AssetFormSheet.tsx` | 324 | `RecordFormShell` at `/finance/fixed-assets/new` + `/:id/edit` |
| 10 | Fixed asset peek | `src/features/finance/fixed-assets/AssetDetailSheet.tsx` | 136 | `PeekScaffold` at `?peek=<id>` |

Call-site sweep (must all be rewired): `src/pages/Budgets.tsx`, `Banking.tsx`, `BankReconciliation.tsx`, `BankFeeds.tsx`, `CreditNotes.tsx`, `FixedAssets.tsx`, `finance/CustomerCredits.tsx`, `contacts/ContactProfile.tsx`, `src/test/architecture/banking-ownership.test.ts`.

### Execution plan (one wave per row, ledger-honest)

For each item above, the same recipe:

1. **Build the target surface** — route file(s) under `src/routes/`, page under `src/features/finance/<domain>/`, composed on `RecordFormShell` / `RecordScaffold` / `WizardShell` / `PeekScaffold` from `@/design-system`; submit lifecycle via `useRecordFormSubmit`; peek deep-link via `usePeekParam`.
2. **Port every existing behaviour verbatim** — validation, RPC calls, toast copy, permission gates, side-panel activity, unbalanced-line guards, credit checks, oversell confirms. No behavioural regressions.
3. **Rewire every call site** to `navigate(...)` (create/edit) or `?peek=<id>` (peek). Grep the file's basename after each wave to prove zero live imports.
4. **Delete the legacy file** in the same wave.
5. **Update the ledger row** (`docs/design-system/audit/finance.md`) to `Done` with the new file paths, and mirror the change in the guard test's data-model row.
6. **Tighten the guard** — after item 10, extend `finance-record-dialog-ban` to (a) match arbitrary `*Dialog.tsx` under the finance/banking/accounting surface with an explicit empty allowlist, (b) match `*Sheet.tsx` under `src/features/finance/` with a shrinking allowlist, so future regressions surface immediately. Then freeze the memory core rule.
7. **Verify each wave** — `tsgo -p tsconfig.app.json --noEmit`, `bunx vitest run src/test/architecture/finance-record-dialog-ban.test.ts src/test/architecture/banking-ownership.test.ts`, and a smoke Playwright pass on the migrated route.

Waves 1 + 2 land together (they share the reconciliation workspace). Waves 3, 4, 5, 6 are independent. Wave 8 splits Budgets into a routed form + line grid in a single edit — no partial Sheet retention. Waves 9 + 10 land together (asset form + peek share the same list page rewire). Wave 11 = guard tightening + memory freeze.

### Technical notes

- Reconciliation workspace becomes the canonical example of a Finance **split-view** `RecordScaffold`: transactions list on the left, side rail for the currently-selected txn with inline match/create-JE/transfer actions. The two dialogs collapse into inline forms inside the side rail — no navigation, no modals.
- Bank Account promotion is the largest single file (1107 LOC). It contains connect flow + edit flow + provider onboarding. Route split: `/finance/banking/accounts/new` (create — manual + connect provider tabs live inside the form as `RecordFormShell` sections), `/:id/edit` (edit — no provider tabs). Provider OAuth handoff logic moves unchanged into a shared hook so both routes reuse it.
- Budgets: the `ManageBudgetSheet` line-editor becomes a `LineItemsGrid` embedded in the edit page, eliminating the sheet-inside-sheet nesting.
- Fixed Assets peek uses `PeekScaffold` with the existing depreciation-schedule table as an `extraSection`, matching the Sales/Purchases peek shape.
- No database migrations required — all RPCs already exist. Every remaining item is presentation-layer work.

### Definition of done

- All 6 dialogs and 6 sheets above deleted; every call site navigates to a route or opens a `?peek=<id>` sheet on `PeekScaffold`.
- `docs/design-system/audit/finance.md` shows every row `Done`; no "Pending" / "Deviation" markers remain.
- `finance-record-dialog-ban` guard broadened to `*Dialog.tsx` + `*Sheet.tsx` under the finance surface with empty allowlists.
- Memory core line updated: finance guard flipped from "shrink-only" to "frozen (empty allowlist)".
- `tsgo` clean, all architecture tests green.
