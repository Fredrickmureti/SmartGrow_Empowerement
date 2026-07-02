# Payroll / Localization / GL — Re-Verification Audit (Phase 0)

Date: 2026-05-25
Scope: independent re-verification of the prior plan (`.lovable/plan.md`) against current source and live DB. **No code changed in this phase.** All findings cross-checked against `supabase/functions/`, `supabase/migrations/`, `src/components/payroll/**`, `src/components/employees/**`, and live tables via `supabase--read_query`.

Verdict legend: **PASS** = already fixed, **FAIL** = still present, **PARTIAL** = guard added but data/UI still leaks.

## L-series (country leakage & multi-jurisdiction)

| ID | Finding | Status | Evidence |
|---|---|---|---|
| L1 | `rule.rule_type === "housing_exemption" \| "personal_relief" \| "insurance_relief"` intercepts in compute-payroll | **FAIL** | `supabase/functions/compute-payroll/index.ts:724–734` still contains the three literal intercepts. |
| L2 | KE taxable-income formula `grossPay - exemptHousing` | **FAIL** | `compute-payroll/index.ts:1116–1117` unchanged. |
| L3 | `insurancePremium` is a global `CalcContext` field sourced from `employees.insurance_premium` | **FAIL** | `compute-payroll/index.ts:148–153, 545, 1120–1129` unchanged. |
| L4 | `STATUTORY_REPORT_MAP` KE-only download buttons | **FAIL** | `src/components/payroll/PayrollRunDetailsDialog.tsx:230, 341` unchanged. |
| L5 | `generate-localization-statutory-document` parallel hardcoded KE generator | **FAIL** | File still present, still KE-walled. |
| L6 | `UNIQUE(business_id)` on `installed_localization_packs` blocks multi-country | **FAIL** | Index `installed_localization_packs_business_unique` still exists (no superseding migration found in grep). |
| L7 | `post-payroll-gl` resolves pack via org-level query | **FAIL** | `supabase/functions/post-payroll-gl/index.ts:457–465` — still `.eq("organization_id", organization_id).order("business_id", { ascending: false, nullsFirst: false }).limit(1)`. |

## H-series (pack & provisioning)

| ID | Finding | Status | Evidence |
|---|---|---|---|
| H1 | No `uninstall-localization-pack` workflow | **FAIL** | No such edge function in `supabase/functions/`. |
| H2 | Pack-version upgrade does not re-seed tenants | **FAIL** | `promote-pack-version` has no tenant fan-out. |
| H3 | `payroll_statutory_rules` has no unique constraint | **FAIL** | grep of migrations shows only the lookup index, no `UNIQUE(...)`. |
| H4 | `force_reseed=true` does not update existing rules | **FAIL** | install-localization-pack still uses the skip-if-exists branch. |
| H5 | `statutoryLabelsFor()` 8-country switch in client | **FAIL** | `src/components/employees/EmployeePayrollInfo.tsx:24–59`. |
| H6 | `"replaced_by_shif"` sentinel string in installer | **FAIL** | `install-localization-pack/index.ts:349` (unchanged). |

## M-series (medium hardening)

| ID | Finding | Status | Evidence |
|---|---|---|---|
| M1 | install is not transactional | **FAIL** | No `install_localization_pack_atomic` RPC. |
| M2 | `housing_allowance` / `transport_allowance` hardcoded earning buckets | **FAIL** | `compute-payroll/index.ts:1017–1020, 1307–1308`. |
| M3 | `defaultCountry || "KE"` bias | **FAIL** | `src/pages/hr/PayrollStatutoryRules.tsx:995`; `StatutoryRuleEditor.tsx:98,168`. |
| M4 | `en-US` payslip locale hardcoded | **FAIL** | `generate-payslip-pdf:389`. |
| M5 | `!` non-null assertions in post-payroll-gl GL fallback | **FAIL** | `post-payroll-gl/index.ts:340, 341, 356, 391, 392` — every resolveAccount(...) is bang-asserted. |
| M6 | Remittance due_date not stamped on liability | **FAIL** | confirmed; `payroll_liabilities` has no `due_date` column (would need migration). |
| M7 | `parent_code` FK not validated | **FAIL** | no validator in installer. |

## What HAS been done (since the prior plan)

Cross-checked migrations dated 2026-05-25 — three relevant waves landed earlier today:

- `20260525124505` — first cut of `payroll_apply_proposed_mappings` + `payroll_create_and_map_account` with role gates.
- `20260525162011` — hardened versions of the above: `_payroll_assert_mapping_role` rejects (a) header accounts, (b) `salary_expense` / `*_employer_expense` mapped to COGS-flavoured accounts (via `_payroll_is_cogs_account`), (c) wrong `account_type` for the role. Plus seeds country-neutral payroll accounts `6150`, `6160`, `2140`, `2150`, `2160`, `2170` into `default_chart_of_accounts`.
- `20260525172513` — **R1**: BEFORE INSERT/UPDATE trigger `trg_default_account_settings_payroll_role` so EVERY write to `default_account_settings` (not just writes through the RPC) is gated by `_payroll_assert_mapping_role`. **R2**: `payroll_generate_reclassification_je(p_run_id)` RPC + `payroll_reclassification_audit` table to correct already-posted COGS-misposted JEs.

## What those waves DID NOT solve (the live data gap)

The trigger fires only on new writes. The 13 existing rows in `default_account_settings` predate it:

```
org 81695269… (Kenya pack installed):
  salary_expense                            → 5100 Cost of Goods Sold  (detail_type=cost_of_goods_sold)
  affordable_housing_levy_..._employer_expense → 5100 Cost of Goods Sold
  nssf_..._employer_expense                 → 5100 Cost of Goods Sold
  paye_..._payable                          → 2110 Accounts Payable    (detail_type=accounts_payable)
  nssf_..._payable                          → 2110 Accounts Payable
  shif_..._payable                          → 2110 Accounts Payable
  affordable_housing_levy_..._payable       → 2110 Accounts Payable
  nita_..._payable                          → 2110 Accounts Payable
  net_salary_payable                        → 2110 Accounts Payable

org ad0f633a… :
  salary_expense                            → 5000 Cost of Sales        (detail_type=other_business_expenses)
  net_salary_payable                        → 2000 Liabilities (parent/header!)
```

Three distinct invariant violations are visible in this snapshot:

1. **Salary → COGS** (org 81695269). The new R0/R1 trigger would now reject this write. The row was inserted before the trigger.
2. **Salary → header account `2000 Liabilities`** (org ad0f633a, `net_salary_payable`). Also blocked by R1 going forward.
3. **All `*_payable` mappings collapsed onto `2110 Accounts Payable`** (org 81695269). **Not blocked by any current guard** — `_payroll_assert_mapping_role` only checks `account_type='liability'`; AP is a liability, so it passes. This is the AP-pollution root cause.

## Confirmed remaining critical defects

- **CRIT-A** (data): 9 dirty mappings in org 81695269 + 2 in org ad0f633a will reproduce the original incident on the next payroll post. R1 stops new writes; nothing has cleaned old ones.
- **CRIT-B** (rule gap): `*_payable` mappings can still point to `accounts_payable` detail_type. Statutory payroll obligations belong in dedicated `2140/2150/2160/2170` (which 162011 already seeded into `default_chart_of_accounts`) — the guard must reject the generic AP target the same way it rejects COGS for the expense side.
- **CRIT-C** (drift): without a finance-side integrity check, COGS / AP balances will silently absorb payroll amounts again on the next slip-up. Reporting layer does not assert account `detail_type` matches the bucket.

## Mapping to next phases

| Defect | Next phase |
|---|---|
| CRIT-A | Phase 2 (data remediation + Phase 5 reclassification rerun for any posted runs in the meantime). |
| CRIT-B | Phase 2 (extend `_payroll_assert_mapping_role` to deny `detail_type='accounts_payable'` for `*_payable` keys; the country-neutral `2140` accounts already exist). |
| CRIT-C | Phase 6 (`fetchGLTotals` + nightly integrity check assertions). |
| L1–L7, H1–H6, M1–M7 | Phases 3–5 as planned, no scope changes after this audit. |

## Sources reviewed

- Code: `supabase/functions/compute-payroll/index.ts`, `supabase/functions/post-payroll-gl/index.ts`, `supabase/functions/install-localization-pack/index.ts`, `supabase/functions/generate-localization-statutory-document/index.ts`, `supabase/functions/apply-default-mappings/index.ts`, `src/components/payroll/PayrollRunDetailsDialog.tsx`, `src/components/employees/EmployeePayrollInfo.tsx`, `src/pages/hr/PayrollStatutoryRules.tsx`, `src/components/payroll/StatutoryRuleEditor.tsx`, `src/services/gl/fetchGLTotals.ts`.
- Migrations: full text of `20260525124505`, `20260525162011`, `20260525172513`; grep of all `supabase/migrations/*.sql` for `installed_localization_packs_business_unique`, `payroll_statutory_rules`, `default_account_settings`.
- Live DB via `supabase--read_query`: `default_account_settings`, `accounts`, `journal_entries`, `journal_entry_lines`, `payroll_runs`.