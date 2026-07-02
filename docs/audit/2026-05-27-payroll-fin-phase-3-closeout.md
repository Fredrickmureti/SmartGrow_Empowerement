# Payroll/Finance Hardening — Phase 3 closeout (2026-05-27)

Closes every item flagged "deferred" in `2026-05-26-payroll-fin-phase-3-status.md`.

## Stage A — Re-verification (PASS)

All nine Phase 2/3 invariants re-proved against live source + schema. No drift since the Phase 3 status doc:

| # | Invariant | Result |
|---|-----------|--------|
| 1 | `payroll_account_role_policy` rows + columns seeded | PASS |
| 2 | `_payroll_assert_mapping_role` reads policy only | PASS |
| 3 | `trg_default_account_settings_payroll_role` attached | PASS |
| 4 | `trg_enforce_payroll_je_account_class` rejects denied classes | PASS |
| 5 | `payroll_mapping_findings` view consults policy only | PASS |
| 6 | `payroll_validate_post_mappings` delegates to view | PASS |
| 7 | `post-payroll-gl` has no hardcoded role checks | PASS |
| 8 | `no-hardcoded-payroll-role-matrix` CI guard green | PASS |
| 9 | `default_account_settings` has zero policy-rejected rows | PASS |

## Stage B — Six deferred items shipped

| # | Item | Where |
|---|------|-------|
| B1 | Generic `taxable_income_adjustments[]` + `housing_exemption` sentinel deprecated (still parsed, emits `DEPRECATED_HOUSING_EXEMPTION_RULE` warning) | `supabase/functions/compute-payroll/index.ts` |
| B2 | Per-rule `requires_input` + `ctx.inputs` registry; `CalcContext.insurancePremium` removed | `supabase/functions/compute-payroll/index.ts` |
| B3 | `STATUTORY_REPORT_MAP` deleted; dialog uses `useReturnTemplates()` → `localization_pack_return_templates` | `src/components/payroll/PayrollRunDetailsDialog.tsx` |
| B4 | `statutoryLabelsFor()` switch deleted; component reads `useEmployeeStatutoryIdentifiers(employeeId)`; legacy-column fallback rendered with "Legacy values" badge | `src/components/employees/EmployeePayrollInfo.tsx`, `src/hooks/employees/useEmployeeStatutoryIdentifiers.ts` |
| B5 | Country fallback chain → `currentBusiness?.country ?? currentOrg?.country ?? "GENERIC"`; payslip locale `"en"` not `"en-US"` | `src/components/payroll/StatutoryRuleEditor.tsx`, `src/pages/hr/PayrollStatutoryRules.tsx`, `supabase/functions/generate-payslip-pdf/index.ts` |
| B6 | `payroll_validate_post_mappings` + `post-payroll-gl` re-verified DONE in Stage A | — |

## Stage C — Tests

| Suite | Protects |
|-------|----------|
| `src/test/architecture/no-country-switch-in-payroll-ui.test.ts` | No `switch (country)` reappears in payroll UI |
| `src/test/architecture/payroll-engine-contracts.test.ts` | Engine keeps `taxable_income_adjustments` path, sentinel stays a deprecated shim with warning, `ctx.inputs.insurance_premium` registry, no country ladders |
| `src/test/architecture/payroll-ui-statutory-data-driven.test.ts` | Dialog uses `useReturnTemplates`, employee info uses `useEmployeeStatutoryIdentifiers`, editor uses `GENERIC` fallback |
| `src/test/architecture/no-hardcoded-payroll-role-matrix.test.ts` (pre-existing) | No parallel role matrix sneaks back into TS or SQL |

## Stage D — Documentation

- This doc.
- `2026-05-26-payroll-fin-phase-3-status.md` — six deferred rows marked DONE.
- `.lovable/plan.md` — updated to the four-checkpoint Phase 4/5/6 plan.

## Verdict

Phase 3 is closed. Engine and UI are fully country-agnostic; jurisdiction-specific behavior is sourced from `payroll_statutory_rules` + `localization_pack_return_templates` + `employee_statutory_identifiers` only.

Remaining work (Phases 4/5/6) is now in progress under separate checkpoints in `.lovable/plan.md`.
