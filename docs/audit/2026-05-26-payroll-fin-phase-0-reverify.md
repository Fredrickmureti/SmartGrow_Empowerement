# Payroll / Finance / Localization — Phase 0 Re-verification (2026-05-26)

Independent re-check of every claim made by the prior two passes
(`2026-05-26-payroll-fin-phase-2-reverify.md` and
`2026-05-26-payroll-fin-phase-3-status.md`) against live DB + current
source. No code changed in this pass.

Legend: **PASS** = claim confirmed, **FAIL** = claim wrong / still
broken, **PARTIAL** = claim partially holds, **NEW** = something the
prior passes did not flag.

---

## 1. Policy table + triggers

| # | Claim | Result | Evidence |
|---|---|---|---|
| 1.1 | `payroll_account_role_policy` exists, 4 rows, columns `setting_key_pattern / allowed_account_types / denied_detail_types` | **PASS** | Live query returns 4 rows: `salary_expense`, `%_employer_expense`, `%_payable`, `net_salary_payable`. Each carries `allowed_account_types` + `denied_detail_types`. |
| 1.2 | `bank_clearing` policy row still missing | **PASS (gap)** | Confirmed absent. Carried into Stage 4. |
| 1.3 | `_payroll_assert_mapping_role`, `_payroll_assert_je_line_account`, `payroll_validate_post_mappings` functions present | **PASS** | `pg_proc` count = 1 for each. |
| 1.4 | `trg_default_account_settings_payroll_role` + `trg_enforce_payroll_je_account_class` attached | **PASS** | `pg_trigger` count = 1 for each. |
| 1.5 | `payroll_mapping_findings` view consults `payroll_account_role_policy` (no hardcoded CASE) | **PASS** | View body dumped: 2 `EXISTS (SELECT 1 FROM payroll_account_role_policy …)` subqueries drive the verdict; the residual `CASE WHEN detail_type='cost_of_goods_sold' THEN …` is only a label mapper on top of policy-derived violations, not a parallel matrix. CI guard `no-hardcoded-payroll-role-matrix.test.ts` would still catch a regression. |

## 2. Dirty data

| # | Claim | Result | Evidence |
|---|---|---|---|
| 2.1 | 0 violating rows in `default_account_settings` after the repoint | **PASS** | `payroll_mapping_findings` returns 0 rows. The 2 rows still mapping `accounts_payable → 2110 AP` are setting_key=`accounts_payable` (AR/AP module mapping, not payroll) and are correctly excluded by the view's `setting_key NOT IN ('accounts_payable','accounts_receivable')` filter. |
| 2.2 | `payroll_runs` is empty (reclassification moot) | **PASS** | `count = 0`. |
| 2.3 | NEW — no posted payroll JEs to reclassify | **PASS** | `journal_entries WHERE source_type='payroll'` count = 0. |

## 3. Validator path

| # | Claim | Result | Evidence |
|---|---|---|---|
| 3.1 | `payroll_validate_post_mappings` is the single call site used by `post-payroll-gl` | **PASS** | `post-payroll-gl/index.ts:318` calls the RPC by name; no role→type literal matrix anywhere in the file. |
| 3.2 | M5 — bang-asserted `resolveAccount(...)!` calls still present | **FAIL (claim was that it's still broken)** | Confirmed STILL present at lines 340, 341, 356, 391, 392, 518. Status unchanged from RCA. Carried into Stage 4. |

## 4. Country leakage (L/H/M)

| ID | Finding | Result | Evidence |
|---|---|---|---|
| L1 | `rule.rule_type === "housing_exemption" \| "personal_relief" \| "insurance_relief"` literal intercepts in `compute-payroll` | **FAIL (still present)** | `index.ts:726, 733`. |
| L2 | KE taxable-income formula uses `exemptHousing` | **FAIL (still present)** | Wiring still tied to the L1 sentinel; same intercept path. |
| L3 | `ctx.insurancePremium` is a global CalcContext field | **FAIL (still present)** | `index.ts:152, 203, 1120, 1129`. |
| L4 | `STATUTORY_REPORT_MAP` KE-only block in `PayrollRunDetailsDialog.tsx` | **FAIL (still present)** | `PayrollRunDetailsDialog.tsx:230, 341`. |
| L5 | `generate-localization-statutory-document` parallel KE generator | **FAIL (still present)** | Edge function still in `supabase/functions/` (not deleted, not refactored). |
| L6 | `installed_localization_packs_business_unique` blocks multi-country | **FAIL (still present)** | `pg_indexes` confirms the index exists. |
| L7 | `post-payroll-gl` pack resolution is org-level fallback | **FAIL (still present)** | `post-payroll-gl/index.ts` pack-resolution block unchanged. |
| H1 | No `uninstall-localization-pack` edge function | **FAIL** | Not present in `supabase/functions/`. |
| H2 | `promote-pack-version` has no tenant fan-out | **FAIL** | Unchanged. |
| H3 | `payroll_statutory_rules` lacks unique constraint | **PARTIAL** | A unique INDEX `payroll_statutory_rules_dedup_idx` exists (migration `20260507223323`), but no declarative table-level `UNIQUE` and no dedup migration ever ran. Treat as FAIL for the Stage 2 deliverable. |
| H4 | `force_reseed=true` skip-if-exists branch still in place | **PARTIAL** | `install-localization-pack/index.ts:152` only re-enters the seeding path when `force_reseed=true`; downstream the rules block uses `payroll_rules_skipped_existing` counter (line 474) and never UPDATEs existing rules. Real UPSERT path still missing. |
| H5 | `statutoryLabelsFor()` 8-country switch in `EmployeePayrollInfo.tsx` | **FAIL (still present)** | `EmployeePayrollInfo.tsx:24, 59`. |
| H6 | `"replaced_by_shif"` sentinel string | **FAIL (still present)** | `install-localization-pack/index.ts:349`. |
| M1 | install is not transactional | **FAIL** | No `install_localization_pack_atomic` RPC. |
| M2 | `housing_allowance` / `transport_allowance` hardcoded earning buckets | **FAIL** | `compute-payroll/index.ts:1017, 1030`. |
| M3 | `defaultCountry \|\| "KE"` bias | **FAIL** | `StatutoryRuleEditor.tsx:98, 168`; `PayrollStatutoryRules.tsx:995`. |
| M4 | `"en-US"` payslip locale | **FAIL** | `generate-payslip-pdf:389`. |
| M5 | Bang-asserted resolveAccount calls | **FAIL** | Confirmed (see 3.2). |
| M6 | `payroll_liabilities.due_date` not stamped | **PARTIAL → upgraded** | **NEW finding:** The column `payroll_liabilities.due_date` **does already exist** in the live schema (information_schema check). RCA claim that it's missing is stale. Still need to verify the posting path actually stamps it; deferred to Stage 3 verification. |
| M7 | `parent_code` FK not validated in installer | **FAIL** | Unchanged. |

## 5. CI guards

| Test file | Present | Notes |
|---|---|---|
| `no-hardcoded-payroll-role-matrix.test.ts` | ✓ | Phase 3 deliverable. |
| `no-hardcoded-country-payroll.test.ts` | ✓ | Predates this round; scope to be widened in Stage 1. |
| `payroll-mapping-trigger-guard.test.ts` | ✓ | Phase 2 deliverable. |
| `post-payroll-gl-validates-mappings.test.ts` | ✓ | Phase 2 deliverable. |

Tests not run in this pass (read-only audit). Stage 1 will run the suite
before any code change.

---

## Net verdict

**Phase 2 and Phase 3 part 1 claims hold up.** The COGS / generic-AP /
header-account attack surface is closed at three layers (mapping trigger,
JE-line trigger, UI findings view), all reading
`payroll_account_role_policy`, with a CI guard preventing re-encoding.

**Every deferred item from Phase 3 status doc is still real and still
unfixed:**

- 14 of 17 L/H/M items are FAIL (unchanged).
- 2 are PARTIAL (H3, H4).
- 1 (M6) is **better than RCA claimed** — column already exists; only the
  stamping behavior needs verification.

**One new finding worth surfacing:** `compute-payroll` still selects
`insurance_premium` from the `employees` table even though L3 calls the
field KE-specific. This means the schema itself leaks country-specific
columns into the generic employees table. Whether to migrate this to a
generic `employee_statutory_inputs` table is a Stage 1 design call.

---

## What proceeds without further questions

Stages 1 (Phase 3 country-leakage closure) and Stage 6 (test corpus
expansion) can proceed immediately. Both are additive and reversible.

## Approval gate — STOP

Per the approved plan, three gates require confirmation before crossing:

1. **Stage 2 (multi-jurisdiction schema break)** — drops
   `installed_localization_packs_business_unique`, adds NOT-NULL
   `business_id`, adds `employees.statutory_country_code`. Schema-break;
   needs scheduled window.
2. **Stage 3 (pack lifecycle)** — introduces `uninstall-localization-pack`
   and the atomic install RPC; existing installs need behavior
   confirmation.
3. **Stage 4 (finance integrity) — `bank_clearing` policy row + allow-list
   column** — tightens `_payroll_assert_mapping_role`; could reject
   previously-acceptable mappings on legacy tenants.

Awaiting approval to proceed past Stage 1 + Stage 6.
