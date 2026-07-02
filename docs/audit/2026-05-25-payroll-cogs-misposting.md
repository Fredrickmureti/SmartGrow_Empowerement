# Payroll → Cost of Goods Sold misposting — root cause & remediation

_Date: 2026-05-25_
_Tenants affected (at time of writing): Accrual Traders (`81695269-0f41-4aec-8f49-2fa6d11946b2`), `ad0f633a-d24c-4602-82f3-cf98ced2c246`._

## Symptom

After running and posting a payroll run, the user observed:

1. The salary expense line had been posted to **5100 Cost of Goods Sold** / **5000 Cost of Sales**, polluting the gross-margin figure on the P&L.
2. The Finance module showed a "drift" between the posted GL value and the AP/expense reports because PAYE, NSSF/SHIF and net-salary obligations had all been folded into the catch-all **2110 Accounts Payable** / **2000 Liabilities** header.

## Root cause

`public.payroll_required_gl_mappings_for_run` (migration `…_158be0d4…`) was suggesting accounts purely by name fuzzy-match (`'%salary expense%'`) and lowest `code`. In a freshly-seeded Chart of Accounts the only expense accounts are the COGS family, so the salary key always landed on COGS. The companion "Apply proposed mappings" RPC accepted whatever the suggester returned without validating the account class.

QuickBooks Payroll, Xero Payroll, NetSuite SuitePeople, Sage and Odoo all bind payroll mappings to *named roles* defined in the payroll module, not to free-text "find an expense account". Posting payroll to COGS is a deliberate cost-accounting choice (job costing / WIP) and is never the default.

## What changed (this migration)

1. **Role-aware suggester.** `payroll_required_gl_mappings_for_run` now:
   - Hard down-ranks COGS / Cost-of-Sales accounts for `salary_expense` and `*_employer_expense` keys.
   - Up-ranks accounts whose name/code looks payroll-flavoured (salary, wages, payroll, staff cost, compensation, employer contribution; or payable/withhold/statutory/PAYE/NSSF/SHIF/NHIF for liabilities).
   - Penalises generic catch-all liability accounts (Accounts Payable, bare "Liabilities") so they aren't auto-picked.

2. **Apply-mappings guard.** `payroll_apply_proposed_mappings` now raises `payroll_mapping_role_violation` when a salary or employer-expense key is being mapped to a COGS account. Existing mappings are left intact.

3. **Diagnostic view.** New `public.payroll_mapping_findings` lists every tenant whose existing mapping violates the role rules (`salary_expense_mapped_to_cogs`, `payroll_payable_mapped_to_header`, `payroll_payable_mapped_to_generic_ap`). The Payroll → GL setup screen will surface these as critical/warning findings in a follow-up turn.

## What did NOT change (and why)

- **Posted journal entries.** Already-posted JEs are immutable. The remediation path for affected tenants is:
  1. Open the new findings in Payroll → GL setup, accept the new role-aware suggestion (or pick manually).
  2. Run a one-off reclassification journal `Dr. 6210 Salaries & Wages / Cr. 5100 COGS` for the period sum. This is a manual JE today; the planned UI action is a follow-up.
- **Chart-of-accounts seed.** Seeding a dedicated `6200 Payroll Expenses` block and per-statutory `22xx Payable` accounts is queued for a follow-up wave so it can be done atomically with the localisation pack templates.

## Follow-up waves

- **P1:** Payroll → GL setup UI: surface `payroll_mapping_findings`, expose the role-aware suggestions inline, add "Generate reclassification journal" action for already-posted runs.
- **P2:** Seed `6200 Payroll Expenses` family + per-statutory payable accounts in `default_chart_of_accounts` and the localisation pack templates; backfill on new tenants.
- **P3:** Add `account_role_eligibility` rows for `payroll_salary_expense`, `payroll_employer_expense`, `payroll_statutory_payable[rule_code]`, `payroll_net_pay_payable`, `payroll_loan_deduction_payable` so the suggester becomes role-driven rather than name-heuristic.

## Verification

```sql
-- Should return one row per affected tenant.
SELECT organization_id, setting_key, account_code, account_name, violation_code, severity
FROM public.payroll_mapping_findings
ORDER BY severity, organization_id;

-- Should now reject:
SELECT public.payroll_apply_proposed_mappings(
  '<org>'::uuid, NULL,
  '[{"setting_key":"salary_expense","account_id":"<cogs-account-uuid>"}]'::jsonb
);
-- → ERROR: payroll_mapping_role_violation: setting_key salary_expense cannot map to a Cost of Goods Sold / Cost of Sales account
```
---

## Wave 2 — re-audit and bypass closure (2026-05-25, later same day)

### Bypass RCA
Postgres carried two overloads of `payroll_apply_proposed_mappings`:
`(uuid, uuid, jsonb)` (guarded) and `(uuid, uuid, jsonb, uuid)` (NOT guarded —
it routed through `_upsert_default_account_setting` with no role check). Both
client call sites (`usePayrollAccountMappings.upsertMapping` and
`usePayrollGlReadiness.applyAll`) always pass `_branch_id`, so they always
resolved to the unguarded 4-arg overload. The Wave-1 COGS guard was therefore
dead code on the user path. Same dual-overload pattern existed for
`payroll_create_and_map_account`.

### What Wave 2 changes
1. Both overloads of `payroll_apply_proposed_mappings` are dropped. A single
   branch-aware version is the only writer; it always calls the new
   `_payroll_assert_mapping_role(setting_key, account_id)` helper which
   enforces:
   - no header / parent accounts for any payroll key;
   - no COGS / Cost-of-Sales accounts for `salary_expense` /
     `*_employer_expense`;
   - account class must match (expense for salary/employer-expense,
     liability for `*_payable`).
2. Both overloads of `payroll_create_and_map_account` are dropped and
   replaced with a single guarded version that also rejects
   COGS-flavoured names up-front.
3. New `payroll_validate_post_mappings(p_run_id)` returns critical findings
   scoped to a run. `post-payroll-gl` now calls it after the
   missing-mappings check and aborts with
   `{ error: "role_violation", findings, action }` if any critical
   violation remains, so posting can never be the moment a mis-mapping is
   first detected.
4. `default_chart_of_accounts` is seeded (country-neutral) with
   `6150 Payroll: Employer Contributions`, `6160 Payroll: Other Costs`,
   `2140 Payroll Statutory Payable`, `2150 Income Tax Withheld Payable`,
   `2160 Pension Contributions Payable`, `2170 Net Salary Payable`.
   Country-specific statutory names continue to live in localisation packs
   (the `default_coa_no_statutory` check constraint enforces this).

### Invariants (do not regress)
- `default_account_settings` writes for payroll keys MUST go through
  `payroll_apply_proposed_mappings` or `payroll_create_and_map_account`.
  No direct INSERT/UPDATE from client or other RPCs.
- The two RPCs above MUST remain the only writers and MUST keep the
  `_payroll_assert_mapping_role` call. Do not add a new overload — drop
  and replace the existing signature instead.
- `post-payroll-gl` MUST call `payroll_validate_post_mappings` between
  the missing-mappings check and the first JE-line build.

### Still deferred to next waves
- UI surface for `payroll_mapping_findings` (banner + per-row "Apply
  suggested" / "Pick account" actions) on the Payroll → GL setup screen.
- `payroll_generate_reclassification_je(...)` function + action to clean
  up the 5 already-posted critical findings without mutating posted JEs.
- pgTAP coverage of the new guards.
