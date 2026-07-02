# Finance Scope Model — Branch vs Business Ownership

This is the canonical reference for which Finance entities are owned at the
**business** (legal entity) level vs **branch** (operational unit) level, and
what a branch user is allowed to see / edit / override.

Aligned with Odoo 17, QuickBooks Online (Classes/Locations), and Xero
(Tracking Categories).

## Ownership matrix

| Entity                          | Owner    | Branch can override? | Branch can view? |
| ------------------------------- | -------- | -------------------- | ---------------- |
| Chart of Accounts               | Business | ❌ no                 | ✅ read-only      |
| Default account mappings        | Business | ❌ no                 | ✅ read-only      |
| Tax rates / tax groups          | Business | ❌ no                 | ✅ read-only      |
| Fiscal periods / lock dates     | Business | ❌ no                 | ✅ read-only      |
| Document & report branding      | Business | ❌ no                 | ✅ read-only      |
| Statutory rules (KRA/eTIMS etc) | Business | ❌ no                 | ✅ read-only      |
| Journal books                   | Business | ❌ no                 | ✅ read-only      |
| Journal entries (posted)        | Business | branch-stamped       | own branch only  |
| Bank accounts                   | Business | branch-assignable    | own branch only  |
| Budgets                         | Business | branch-assignable    | own branch only  |
| Fixed assets                    | Business | branch-assignable    | own branch only  |
| Bank reconciliations            | Business | branch of bank acct  | own branch only  |

## Frontend gating contract (2026-05-15)

The legacy "All Branches" pseudo-context was removed (`BranchContext.switchBranch`
now requires a real branch id). Every signed-in user is ALWAYS inside one
specific branch — by default the headquarters branch (`branches.is_headquarters
= true`).

The headquarters branch IS the parent-business edit surface for shared
finance config. The canonical predicate for hiding mutators on
business-level pages lives in `useFinanceScope` and MUST be the only
expression any page consults:

```ts
isHeadquartersContext   // currentBranch?.is_headquarters === true
isBranchScopedReadOnly  // hasMultipleBranches && !isConsolidated && !isHeadquartersContext
```

`<BranchReadOnlyBanner>` renders iff `isBranchScopedReadOnly === true`.
Pages that show it (business-level only): `Accounts.tsx` (COA),
`FiscalPeriods.tsx` + `finance/FiscalPeriodDetail.tsx`, `finance/FinanceSettings.tsx`.

Pages that MUST NOT render the banner — branch-owned operational entities
where branches manage their own rows (RLS + `applyBranchFilter` enforce the
boundary): `JournalEntries.tsx`, `Banking.tsx`, `BankReconciliation.tsx`,
`BankFeeds.tsx`, `Budgets.tsx`, `FixedAssets.tsx`.

Database backstop: `assert_no_branch_context_for_period_mutation` allows the
mutation when the `app.active_branch_id` GUC points at an HQ branch and
rejects otherwise.

## View rules

- **Branch user** (no `finance.view_consolidated`): every Finance page is
  pre-filtered to their branch. They see their branch's posted JEs, their
  branch's bank accounts, their branch's budgets/assets. They **cannot**
  toggle to "All branches".
- **HQ admin** (`finance.view_consolidated`): may select a specific branch
  OR "All branches consolidated". Aggregate views are explicitly labelled
  in both the page header (`<FinanceScopeBadge />`) and every export PDF
  subtitle (via `enrichExportConfig` + `scope.scopeLabel`).
- Cross-business: **never** mixed. Reports require a single business
  selection (`<CompanyScopeGate />`).

## Write rules

- COA / mappings / fiscal periods / taxes: write requires
  `user_has_module_permission(... 'finance', 'manage')` enforced both at
  RLS and via `<PermissionGate permission="finance.manage_settings">`.
- Manual JE create / void / reverse: routed through
  `create_journal_entry_atomic` / `void_journal_entry_atomic` — never via
  direct table writes. Branch users can only post to their own branch.
- Bank reconciliation: `reconcile_bank_transaction_atomic` enforces
  `bank_txn.bank_account.branch_id = current_branch` for branch users.

## Wave-2 follow-ups completed (2026-05-04)

- Branch filter now wired end-to-end on Trial Balance, General Ledger,
  Balance Sheet, P&L, AR/AP Aging, Partner Ledger, Cash Flow, Journal,
  **Audit Trail**, **Depreciation Report**, and **Budget vs Actual**
  (which scopes by the budget's own `branch_id`).
- Tax Reports and Management Reports inherit branch scope from the
  underlying invoice/bill/expense hooks (already branch-scoped).
- All exports include the active scope label in the PDF subtitle.

See `src/test/architecture/financial-reports-scope-labeling.test.ts` for
the contract guards.

## Banking ownership invariants (2026-05-16)

Enforced at the database, not just in code (migration `20260516`):

- **R1.** `(business_id, provider_id, external_account_id)` is UNIQUE on
  `bank_accounts` → one external bank account can only be connected once
  per business. Two branches cannot independently OAuth the same Equity
  Bank account.
- **R2.** `(business_id, provider_id, account_number)` is UNIQUE for
  manual entries (no `external_account_id`) → same guard for CSV-import
  workflows.
- **R3.** A `BEFORE INSERT OR UPDATE` trigger
  `enforce_bank_txn_scope_matches_account` rewrites
  `bank_transactions.business_id / branch_id` to mirror the parent
  `bank_account`. An `AFTER UPDATE` trigger
  `cascade_bank_account_scope_to_txns` re-stamps history when an
  account's `branch_id` is changed.
- **R4.** Partial unique index
  `bank_reconciliation_one_open_per_account` allows only one
  `in_progress`/`draft` reconciliation session per `bank_account_id`.
- **R5.** CHECK `bank_accounts_shared_branch_consistency`:
  `is_shared = true ⇔ branch_id IS NULL`.
- **R7.** `supabase/functions/sync-bank-transactions` explicitly stamps
  `business_id` + `branch_id` on every transaction insert (defence in
  depth alongside R3).
- **G4.** `BEFORE INSERT/UPDATE` trigger
  `enforce_recon_session_scope_matches_account` rewrites
  `bank_reconciliation_sessions.{organization_id, business_id, branch_id}`
  to mirror the parent `bank_account` — sibling-defect class to R3.
- **G5.** Partial unique index
  `bank_accounts_manual_no_provider_unique` on
  `(business_id, account_number) WHERE provider_id IS NULL` — closes the
  manual-no-provider duplicate gap not covered by R2.

> **Trigger contract.** The R3 trigger fires on
> `INSERT OR UPDATE OF bank_account_id, business_id, branch_id`. Any
> future migration that introduces a column whose mutation should
> re-stamp scope must extend that column list — relaxing it would
> silently re-open D3.

The architecture test
`src/test/architecture/banking-ownership.test.ts` prevents regression of
the application-side mappings.
