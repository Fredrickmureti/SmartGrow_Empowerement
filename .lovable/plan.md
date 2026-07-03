## Independent verification of prior work

I re-checked the tree against `.lovable/plan.md` and the last handoff message. State as of now:

- **Sales / Purchases / Inventory** — confirmed complete; ledgers have no `Pending`/`Deviation`, architecture guards exist, no legacy `Create*Dialog`/`Edit*Dialog`/`*DetailDialog` remain. **Not touching.**
- **Finance waves 1–7** — verified done:
  - `ReconcileTransactionDialog` / `TransferReconcileDialog` gone from `src/components/banking/`; folded into `src/features/finance/reconciliation/{ReconcileTransactionSheet,TransferReconcileSheet}.tsx` behind `ReconciliationWorkspace`.
  - `BankAccountSheet.tsx` gone; replaced by `src/features/finance/banking/BankAccountCreatePage.tsx` + `BankAccountEditPage.tsx`, routed under `/finance/banking/accounts/…`. `Banking.tsx` navigates via route (legacy `?sheet=account` redirect in place).
  - `banking-ownership.test.ts` retargeted to the new files.
- **Finance wave 8 (Budgets)** — **not started.** Still present with combined 930 LOC:
  - `src/features/finance/budgets/BudgetFormSheet.tsx` (211)
  - `src/features/finance/budgets/BudgetItemSheet.tsx` (235)
  - `src/features/finance/budgets/ManageBudgetSheet.tsx` (348)
  - `src/features/finance/budgets/CopyBudgetSheet.tsx` (136)
  - Consumed by `src/pages/Budgets.tsx`.
- **Finance wave 11 (guard + memory)** — not done. `finance-record-dialog-ban.test.ts` still only matches `Create*Dialog`/`Edit*Dialog`/`*DetailDialog`; `*Sheet.tsx` and verb-noun dialogs pass through.

Pick up exactly at **Wave 8 → Wave 11**. No rework of waves 1–7.

## Wave 8 — Budgets on `RecordFormShell`

Goal: eliminate the sheet-inside-sheet nesting (`ManageBudgetSheet` opens `BudgetItemSheet`) and give budgets a proper enterprise create/edit workspace matching Journal Entry / Bank Account.

1. **Routes** (file-based, register via `createFileRoute`):
   - `src/routes/finance.budgets.new.tsx` → `BudgetCreatePage`
   - `src/routes/finance.budgets.$id.edit.tsx` → `BudgetEditPage` (loads via `useSuspenseQuery` + `ensureQueryData` in loader)
2. **Pages** in `src/features/finance/budgets/`:
   - `BudgetCreatePage.tsx` — `RecordFormShell` with one section: header fields (name, fiscal period, scope: company/department/project, currency, status). Submit creates the budget and navigates to the edit page (where lines are managed) — matches Journal Entry pattern.
   - `BudgetEditPage.tsx` — same header section, plus a second section rendering account-budget **lines inline via `LineItemsGrid`** (replaces the modal-in-modal `BudgetItemSheet`). Amounts per period column, running total in footer.
   - `useBudgetForm.ts` — shared hook: Zod schema, RHF setup, RPC calls (`create_budget`, `update_budget`, `upsert_budget_line`, `delete_budget_line`), permission gate, toast copy, unbalanced-line guard. Ported verbatim from the three sheets.
3. **CopyBudget** — inspect `CopyBudgetSheet` (136 LOC, 3 fields: source budget, target period, name). Fits the `DetailSheet` ≤6-field standard → keep as-is, but rename to `CopyBudgetDetailSheet.tsx` so it matches the design-system naming and is explicitly allow-listed in wave 11.
4. **Rewire `src/pages/Budgets.tsx`**:
   - Replace `setFormSheetOpen(true)` / `setManageOpen(true)` with `navigate({ to: '/finance/budgets/new' })` and `navigate({ to: '/finance/budgets/$id/edit', params: { id } })`.
   - Keep Copy action opening `CopyBudgetDetailSheet` inline (small utility, no page needed).
   - Add legacy deep-link redirects: `?sheet=budget[&id]` → new routes (mirror the `Banking.tsx` pattern).
5. **Delete** `BudgetFormSheet.tsx`, `BudgetItemSheet.tsx`, `ManageBudgetSheet.tsx`. Grep must return empty for those basenames.
6. **Test updates**:
   - `budgets-business-level-gating.test.ts` — retarget imports to the new pages.
   - Add a lightweight `budgets-ownership.test.ts` mirroring `banking-ownership.test.ts` if the pattern is expected by the audit ledger.

## Wave 11 — Guard tightening + memory + ledger

1. **Broaden `src/test/architecture/finance-record-dialog-ban.test.ts`** to fail on:
   - Any `*Dialog.tsx` under `src/components/{finance,banking,accounting,budgets}` **and** `src/features/finance/**`.
   - Any `*Sheet.tsx` under `src/features/finance/**`.
   - Allowlist: `CopyBudgetDetailSheet.tsx`, and any `DetailSheet.tsx` primitives explicitly ≤6 fields (verify each). After wave 8 the allowlist should be effectively empty except for the CopyBudget utility.
2. **Memory core** (`mem://index.md`): flip the Finance line from "shrink-only" to "frozen (empty allowlist except CopyBudgetDetailSheet)".
3. **Ledger** — `docs/design-system/audit/finance.md`: flip Reconciliation Workspace, Bank Transfer Reconcile, Bank Account, Budget rows to **Done** with new file paths; drop all `Deviation` markers.

## Per-wave verification

Before advancing:
1. `bunx tsgo -p tsconfig.app.json --noEmit`
2. `bunx vitest run src/test/architecture/finance-record-dialog-ban.test.ts src/test/architecture/banking-ownership.test.ts src/test/architecture/budgets-business-level-gating.test.ts`
3. `rg 'BudgetFormSheet|BudgetItemSheet|ManageBudgetSheet' src/` → empty after wave 8.
4. Playwright smoke: `/finance/budgets/new` → create → redirected to `/finance/budgets/:id/edit` → add a line → save → return to `/finance/budgets` and assert row appears.

## Definition of done

- No `BudgetFormSheet` / `BudgetItemSheet` / `ManageBudgetSheet` files remain.
- `Budgets.tsx` navigates via route for create/edit; legacy `?sheet=budget` redirects.
- Broadened guard is green with empty (or CopyBudget-only) allowlist.
- `finance.md` shows every row **Done**.
- `mem://index.md` marks Finance guard frozen.
- `tsgo` clean; all architecture tests green.

## Technical details

- **`LineItemsGrid` reuse** — the same primitive Journal Entry uses. Columns: account (searchable select), period (from budget's fiscal period), amount. Footer shows total; row-level delete; keyboard nav (Tab/Enter to add row) matches the existing pattern.
- **Loader for edit page** — `context.queryClient.ensureQueryData(budgetQueryOptions(id))` in the route loader, `useSuspenseQuery(budgetQueryOptions(id))` in the component. Do **not** use `useEffect + fetch`.
- **Permissions** — reuse the `useBudgetsAccess()` hook the sheets currently call; gate route access via `beforeLoad` that throws `redirect({ to: '/finance/budgets' })` when the user lacks write permission on create/edit.
- **Currency & fiscal period** — pulled from the existing fiscal period / currency selectors already imported by `BudgetFormSheet` — move those imports into `useBudgetForm.ts`.
