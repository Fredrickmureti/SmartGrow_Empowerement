# Payroll Drift Incident — Forensic RCA (Phase 1)

Date: 2026-05-25
Symptom reported by user: "Generated a payroll run and posted to GL — it was posted to **Cost of Goods Sold** and **Accounts Payable**, and the Finance module flagged drift associated with that payroll."

## TL;DR

The drift is **not** a bug in the GL posting engine or the finance reporting layer. It is dirty data in `default_account_settings`: every payroll setting key was auto-mapped (or installer-mapped) to the **first** matching account by `account_type`, which on a freshly installed CoA is `5100 Cost of Goods Sold` (the only expense) and `2110 Accounts Payable` (the only liability). `post-payroll-gl` faithfully posts to those accounts. The Finance module's drift detector is correct: COGS and AP balances no longer reflect product cost / supplier obligations.

The COGS half of this problem was closed off for **new writes** earlier today by the R1 trigger (`20260525172513`). The AP half is **still open**: nothing forbids `paye_payable → 2110 Accounts Payable`, because AP is a liability and the current guard only checks `account_type`.

## The smoking gun (live DB snapshot)

Query against `default_account_settings JOIN accounts`:

```
org 81695269-0f41-4aec-8f49-2fa6d11946b2 (business 7649e800…):
  salary_expense                                  → 5100 Cost of Goods Sold (expense, detail_type=cost_of_goods_sold)
  affordable_housing_levy_ahl_employer_expense    → 5100 Cost of Goods Sold
  nssf_national_social_security_fund_employer_expense → 5100 Cost of Goods Sold
  paye_pay_as_you_earn_payable                    → 2110 Accounts Payable    (liability, detail_type=accounts_payable)
  nssf_national_social_security_fund_payable      → 2110 Accounts Payable
  shif_social_health_insurance_fund_payable       → 2110 Accounts Payable
  affordable_housing_levy_ahl_payable             → 2110 Accounts Payable
  nita_national_industrial_training_authority_payable → 2110 Accounts Payable
  net_salary_payable                              → 2110 Accounts Payable

org ad0f633a-d24c-4602-82f3-cf98ced2c246 (business 7a176122…):
  salary_expense        → 5000 Cost of Sales       (expense, detail_type=other_business_expenses)
  net_salary_payable    → 2000 Liabilities         (HEADER account — also illegal under R1)
```

Aggregate: `SELECT COUNT(*) FROM default_account_settings WHERE setting_key LIKE '%\_payable' AND setting_key <> 'accounts_payable' AND account.detail_type = 'accounts_payable'` → **6 rows**.

## Why the original posting hit COGS / AP

1. `install-localization-pack` (or the legacy `apply-default-mappings`) ran. The auto-mapper resolved each `setting_key` by selecting the first active non-header account matching the expected `account_type`. On a freshly seeded CoA the first expense is `5100 Cost of Goods Sold` and the first liability is `2110 Accounts Payable`, because those are the only such accounts created by the global `default_chart_of_accounts` template.
2. The legacy versions of `payroll_apply_proposed_mappings` and `payroll_create_and_map_account` (pre-162011) did NOT enforce role rules. Even `_payroll_assert_mapping_role` did not exist. Rows were inserted unchallenged.
3. `post-payroll-gl` resolved each line through `resolveAccount(setting_key)` and posted exactly what the mappings said. The engine is innocent — it did its job.
4. `post_journal_entry_atomic` accepted the JE because debits = credits and every account_id is valid; there is no DB-side rule against a payroll JE touching COGS or generic AP.
5. **Finance drift signal**: `fetchGLTotals` correctly sums expenses by `account_type='expense'`, but downstream views (COGS card, AP aging, supplier payables) classify by *account* — and now those accounts include payroll amounts. Hence "drift" associated with the payroll posting.

## Why the prior remediation (Wave 3) is incomplete

| Layer | Status |
|---|---|
| RPC `payroll_apply_proposed_mappings` (162011) | ✅ rejects new bad writes via `_payroll_assert_mapping_role`. |
| Table trigger `trg_default_account_settings_payroll_role` (172513) | ✅ closes the bypass — any write, RPC or raw, is gated. |
| `payroll_generate_reclassification_je` RPC (172513) | ✅ can correct posted runs that hit COGS, AFTER the bad mappings are fixed. |
| Existing dirty rows in `default_account_settings` | ❌ untouched — next post will reproduce the COGS+AP pollution because the trigger only fires on new writes. |
| `*_payable` → `Accounts Payable` (detail_type=accounts_payable) | ❌ NOT rejected by current guard — only the COGS branch was added. AP pollution remains structurally allowed. |
| `fetchGLTotals` / Finance integrity checks | ❌ no assertion that payroll-sourced lines touch only payroll-grade accounts; drift would re-appear silently. |

## Why a `source_type='payroll'` JE was not found in the live DB

Either (a) the user's incident posting was on a different env, or (b) the run + JE were cleared by `clear-org-data` / a reversal. The dirty mapping rows are still present, which means the next posting will reproduce the incident verbatim. The minimum reproducer is: with the current mappings, run any payroll → COGS card on the dashboard increases by `total_gross + total_employer_contributions`, AP aging increases by `total_net + sum(statutory_payable)`.

## Root cause (single sentence)

`default_account_settings` was seeded by an auto-mapper that matched accounts by `account_type` alone, the role-rule trigger that would have rejected those mappings did not exist yet, and the guard added today still permits `*_payable → 2110 Accounts Payable` (the AP detail_type) — so the dirty rows survive and the next payroll post will re-pollute COGS and AP.

## Minimum invariants that would have prevented it (now actionable)

1. **MAP-INV-1**: `*_payable` setting keys (other than `accounts_payable` itself) MUST NOT resolve to an account with `detail_type='accounts_payable'`. Use the dedicated `2140 Payroll Statutory Payable` / `2150 Income Tax Withheld Payable` / `2160 Pension Contributions Payable` / `2170 Net Salary Payable` accounts (already seeded into `default_chart_of_accounts` by `20260525162011`).
2. **MAP-INV-2**: `salary_expense` and `*_employer_expense` MUST NOT resolve to a `detail_type='cost_of_goods_sold'` or `cost_of_sales` account. Already enforced for COGS by `_payroll_is_cogs_account` — extend coverage and apply via the table trigger.
3. **MAP-INV-3**: A header/parent account (`is_header=true`) MUST NOT appear as the target of any payroll setting key. Already enforced for new writes.
4. **JE-INV-1**: When `journal_entries.source_type = 'payroll'`, EVERY line's account must satisfy the same MAP-INV-1/2/3 rules. This is the last line of defense — if the mapping table is poisoned via a future bypass, the trigger on `journal_entry_lines` aborts the post.
5. **FIN-INV-1**: `nightly-integrity-check` must reconcile `sum(payroll-sourced JE expense lines) == sum(posted payroll_runs.total_gross + total_employer_contributions − reclassifications)`. Discrepancy raises a finance-integrity issue surfaced in `/finance/integrity`.

Phase 2 of the plan turns MAP-INV-1, MAP-INV-2, MAP-INV-3, JE-INV-1 into DB triggers and remediates the existing dirty rows; Phase 6 turns FIN-INV-1 into a nightly job.

## Remediation order (no symptom patching)

1. Migration: extend `_payroll_assert_mapping_role` to add MAP-INV-1 (AP detail_type denial for `*_payable`).
2. Migration: dedicated `enforce_payroll_je_account_class` trigger on `journal_entry_lines` for JE-INV-1.
3. Data migration: re-point existing dirty mappings to the seeded `2140/2150/2160/2170/6150/6160` accounts (org-by-org). Where target does not yet exist for the org, call `payroll_create_and_map_account` for the missing role. **No data is destroyed.**
4. For any payroll runs already posted with the dirty mappings, surface a one-click "Reclassify run" action that invokes `payroll_generate_reclassification_je(run_id)`. The audit row in `payroll_reclassification_audit` provides the trail.
5. Wire `fetchGLTotals` integrity assertion (Phase 6).

## What this does NOT cover

- The L/H/M items remain to be executed in Phases 3–5; none of them are root causes of the COGS/AP drift specifically, but L7 (org-level pack lookup) is the path by which a multi-business org could re-create the same dirty state for a second country. Phase 4 closes it.

## Sign-off

Phase 0 + Phase 1 complete. Ready to proceed to Phase 2 (DB invariant trigger + AP detail_type denial + dirty data remediation migration). No code changed in this turn.