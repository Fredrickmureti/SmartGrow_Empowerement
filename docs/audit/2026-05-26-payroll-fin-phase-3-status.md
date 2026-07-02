# Payroll/Finance Hardening — Phase 3 status (2026-05-26)

Continuation of `docs/audit/2026-05-26-payroll-fin-phase-2-reverify.md`.

## What shipped this round

### 1. Collapsed the duplicate payroll role matrix

`payroll_mapping_findings` previously re-encoded the COGS / generic-AP /
header-account denial logic in a hand-written SQL `CASE` next to the
already-shipped `payroll_account_role_policy` table + `_payroll_assert_mapping_role`
trigger. Two sources of truth → guaranteed drift.

Migration `20260525210759_*.sql` rewrites the view to consult
`payroll_account_role_policy` directly. The view now returns:

| violation_code | severity | derived from |
|----------------|----------|--------------|
| `salary_expense_mapped_to_cogs` | critical | policy denied_detail_types + `_payroll_is_cogs_account` fallback |
| `payroll_mapping_header_account` | critical | `accounts.is_header` |
| `payroll_mapping_wrong_account_type` | critical | policy `allowed_account_types` |
| `payroll_payable_mapped_to_generic_ap` | warning | policy `denied_detail_types` ⇒ `accounts_payable` |
| `payroll_mapping_denied_detail_type` | warning | any other denied detail_type |

Result: the UI findings panel, the BEFORE-write trigger, and the JE-line
post-time trigger all read the same matrix. Adding a new payroll setting
key (e.g. for a future jurisdiction) requires touching exactly one row in
`payroll_account_role_policy`.

### 2. CI guard

`src/test/architecture/no-hardcoded-payroll-role-matrix.test.ts` — fails
the build if a parallel role matrix sneaks back into TS / SQL. Detects:

- TS object literal mapping a payroll setting_key to an account_type.
- A `forbiddenPayrollMappings = [...]` array anywhere.
- The old embedded `CASE WHEN das.setting_key LIKE '%_payable' AND
  lower(a.name) IN ('accounts payable', ...)` shape.

Green on first run.

## Verified state of Phase 2 invariants (re-check after Phase 3 migration)

- `trg_default_account_settings_payroll_role` → present, consults policy.
- `trg_enforce_payroll_je_account_class` → present, rejects header /
  revenue / cost_of_goods_sold / accounts_receivable / accounts_payable
  for `source_type='payroll'` JE lines.
- `payroll_mapping_findings` → 0 rows (no dirty data).
- `payroll_runs` → 0 rows (reclassification still moot).

## Explicitly deferred from the original Phase 3 spec → DONE 2026-05-27

All six items closed; details in `docs/audit/2026-05-27-payroll-fin-phase-3-closeout.md`.

(Historical note: the table below was the original deferral list and is kept for traceability.)


| Item | Why deferred | Risk if left |
|------|--------------|--------------|
| Remove `rule.rule_type === "housing_exemption"` sentinel from `compute-payroll` | The taxable-income-adjustment generalization needs a new `payroll_statutory_rules.parameters.taxable_income_adjustments[]` shape + KE pack data migration. Touching the engine without re-running the (currently empty) payroll test corpus is unsafe. | Low — engine is country-agnostic for every other rule; sentinel is harmless as long as packs continue to ship it. |
| Drop `ctx.insurancePremium` from global `CalcContext`; switch to per-rule `requires_input` | Same pack-shape redesign as above. | Low — premium reads from `employees.insurance_premium` which exists in the column set; unused for non-KE employees. |
| Delete `STATUTORY_REPORT_MAP` in `PayrollRunDetailsDialog.tsx`; route through `ReturnsTab` + `localization_pack_return_templates` | UI surgery in a heavily-used dialog; needs design pass for "Returns" tab parity. | Medium — country-specific report labels are visible in the dialog; not a financial-integrity issue. |
| Replace `statutoryLabelsFor()` country switch with `employee_statutory_identifiers.identifier_label` | Requires populating `employee_statutory_identifiers` for every existing employee or shipping a per-country fallback table; a half-done migration would show "—" everywhere. | Low — cosmetic labels only. |
| `defaultCountry \|\| "KE"` and `"en-US"` fallbacks in `StatutoryRuleEditor` + payslip locale | Touch points are simple but the fallback chain needs `currentBusiness?.country` → `currentOrg?.country` → `"GENERIC"` and an explicit "no jurisdiction" UX state. | Low — only affects new-rule editor default selection. |
| Migrate `payroll_validate_post_mappings` RPC to read the policy table | Today it delegates to `payroll_mapping_findings` view, which after this round IS the policy table. **Effectively done** — no further work. | None. |
| `post-payroll-gl` edge function — remove hardcoded role checks | None present in source; it calls `payroll_validate_post_mappings` (now policy-backed) before posting. **Effectively done.** | None. |

## Phases 4 / 5 / 6 — not started

Explicitly out of scope for this round. Each is a multi-day workstream and
requires its own approval gate.

- **Phase 4 (multi-jurisdiction schema unblock):** drop
  `installed_localization_packs_business_unique`, add
  `UNIQUE(business_id, pack_id)`, `payroll_statutory_rules` dedup
  migration, `employees.statutory_country_code`, pack-resolution rewrite
  in `compute-payroll` + `post-payroll-gl`. Breaking change; needs
  scheduled deploy window.
- **Phase 5 (pack lifecycle):** atomic `install_localization_pack_atomic`
  RPC, real `force_reseed` UPDATE path, `uninstall-localization-pack`,
  `promote-pack-version`, `due_date` snapshot, kill `replaced_by_shif`
  sentinel.
- **Phase 6 (finance reporting hardening):** `fetchGLTotals` per-line
  account_type assertion + `finance_integrity_issues` table; extend
  `nightly-integrity-check` to balance payroll JE expense lines against
  `payroll_runs.total_gross + employer_contributions − reversed`; build
  `/finance/integrity` page.

## Verdict

The original incident surface (payroll → COGS, payroll → generic AP) is
now closed at **three** independent layers (mapping trigger, JE-line
trigger, UI findings view), all reading the same policy table, with a
CI guard preventing re-encoding. Phases 4–6 remain the next outstanding
hardening work.
