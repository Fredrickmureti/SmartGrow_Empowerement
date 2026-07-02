# Finance Audit — Wave 6 status

## Wave 5 re-verification (zero-trust)

| Wave 5 claim | Status | Evidence |
|---|---|---|
| Trigger `trg_fiscal_periods_no_branch_context` attached | DONE | `pg_trigger` row present, enabled |
| `close_fiscal_period` / `reopen_fiscal_period` permission-checked RPCs | DONE | Both in `pg_proc` |
| `useFiscalPeriods` switched to RPCs | DONE | Hook calls the new RPCs |
| `useReportFilters` dev-throw | DONE | `ReportFilterContext.tsx` |
| `branchScopability.ts` registry | DONE | File present, classification correct |
| `<ReportBranchFilter>` context-aware (entity-only tooltip + auto-clear) | DONE | Verified |
| Balance Sheet forced entity-level | DONE | `branchId: null` for BS tab |
| `<ReportBranchFilter>` rendered on FinancialReports | DONE | Per-tab |
| Same filter rendered on TrialBalance / GL / Aging / PartnerLedger / Journal / Depreciation / AuditTrail / CashFlow | **WAS MISSING — now DONE in Wave 6 Step 1** | Patched 8 pages |

## Wave 6 work completed

### Step 1 — Branch filter UI now appears on every relevant report page

Each page now mounts `<ReportBranchFilter reportKind="..." />` inside its
`<ReportFilters>` slot. The `reportKind` drives the registry lookup
(`src/lib/reports/branchScopability.ts`) so the same component renders:

- the dropdown for branch-sliceable reports (P&L, GL, Journal, Partner
  Ledger, AR/AP Aging, Depreciation, Audit Trail, Budget vs Actual)
- an inline "Entity-level report" tooltip for entity-only reports
  (Balance Sheet, Cash Flow, Trial Balance, Tax, Consolidation), AND
  clears any stale `branchId` so the next data fetch is the clean
  entity-level statement.

| Page | reportKind | Result |
|---|---|---|
| TrialBalance | `trial_balance` | entity-only hint |
| GeneralLedger | `general_ledger` | dropdown |
| JournalReport | `journal` | dropdown |
| PartnerLedger | `partner_ledger` | dropdown |
| AgingReport | `ar_aging` / `ap_aging` (driven by tab) | dropdown |
| DepreciationReport | `depreciation` | dropdown |
| AuditTrail | `audit_trail` | dropdown |
| CashFlowReport | `cash_flow` | entity-only hint (auto-clears branchId) |

Note on Budget vs Actual: deliberately not changed — `useBudgetVsActual`
is intrinsically scoped by the *budget's own* `branch_id` (a Branch A
budget compares to Branch A actuals) and would be misleading to layer a
separate report-level filter on top of. Documented in the page header.

TaxReports and Consolidation use a custom layout (not `<ReportFilters>`
/ no `ReportPageLayout` filter slot) so they remain entity-only by
design — no toggle was missing.

### Step 2 — Removed legacy duplicate RLS policies on `accounts`

Migration `20260504092409` drops `accounts_insert_per_business`,
`accounts_update_per_business`, `accounts_delete_per_business`. The v2
policies (`accounts_*_perm_v2`) remain — they enforce both the
`financials.{create|write|delete}` module permission AND the new
`finance.manage_coa` permission. Branch users without `finance.manage_coa`
can no longer mutate the COA at the DB layer regardless of the UI.

### Step 3 — Chart of Accounts re-verified (no fixes needed)

DB-layer enforcement on `public.accounts` is already strong:

- `trg_enforce_account_lifecycle`: blocks DELETE on system accounts,
  blocks DELETE if any `journal_entry_lines` reference the account,
  blocks DELETE if account is mapped as a default account, blocks
  `account_type` change on system accounts and on accounts with
  postings, blocks `code` change on system accounts. Writes audit
  rows to `account_change_audit_log` for every mutation.
- `trg_validate_account_detail_type` + `trg_enforce_header_no_detail_type`
  + `trg_validate_account_type_code`: schema-level integrity.
- RLS: `accounts_*_perm_v2` (post Step 2 migration above) require
  `financials.{create|write|delete}` AND `finance.manage_coa`.
- "Apply Defaults" routes through the `apply-default-mappings` edge
  function (eligibility-aware, header-account exclusion) and the
  `<DefaultAccountsConfig>` UI is gated by
  `useFinancePermission("finance.manage_settings")`.

No code changes required. COA is parent-business owned, branches share
it, mutations are double-gated (UI + RLS + trigger). Matches Odoo /
QuickBooks behaviour.

### Step 4 — Journal Entries re-verified (no fixes needed)

DB-layer enforcement on `public.journal_entries`:

- `trg_je_immutable` / `trg_enforce_journal_entry_immutability`:
  posted entries cannot be UPDATEd or DELETEd. Reversal is the only
  legitimate path.
- `trg_fiscal_period_lock_header` + `trg_validate_fiscal_period_je`:
  block INSERT/UPDATE if the entry_date falls in a closed period.
- `trg_je_branch_business_match` + `trg_je_business_org_match`:
  reject mismatched scope at the DB layer (no contamination possible).
- `trg_journal_entries_validate_scope`: source_type / status /
  journal_book_id integrity.
- `trg_enforce_je_balanced` (DEFERRABLE INITIALLY DEFERRED): entry
  must balance at commit time.
- RLS SELECT/UPDATE/DELETE: `user_can_access_branch(branch_id) OR
  has_finance_permission('finance.view_consolidated', business_id)`.
  Branch user cannot see HQ entries; HQ admins with consolidated
  permission can.
- `void_journal_entry_atomic` calls
  `assert_can_void_je(business_id)` — gated by `finance.void_je` plus
  the `user_business_access` check. Frontend (`useJournalEntries.ts`)
  routes both void and reverse through this RPC.

No code changes required. JE flow is accounting-correct, branch-safe,
immutable-after-post, period-aware, and permission-gated.

## Out of scope for Wave 6 (remains for Wave 7+)

- Architecture tests for: report-page filter presence, accounts RLS
  composition, JE branch isolation, closed-period posting block.
  (DB enforcement exists; tests would be belt-and-suspenders against
  future regressions — high value but mechanical.)
- Budgets, Fixed Assets, Banking, Bank Feeds, Reconciliation page
  deep-audits.
- Finance Settings full discovery audit beyond Wave 3 tabs.
- Permissions matrix audit (per-permission × per-page enforcement).

## Net result the user will see

- Open `/reports/general-ledger`, `/reports/aging`, `/reports/journal`,
  `/reports/partner-ledger`, `/reports/depreciation`,
  `/reports/audit-trail` — each now shows the branch dropdown (or
  defaults to current branch for branch-restricted users), and the
  numbers actually change when you switch branches.
- Open `/reports/trial-balance`, `/reports/cash-flow` — each now
  shows an "Entity-level report" hint with a tooltip explaining why
  there is no branch toggle.
- Branch users now cannot mutate COA at the DB layer (in addition to
  the existing UI gate).