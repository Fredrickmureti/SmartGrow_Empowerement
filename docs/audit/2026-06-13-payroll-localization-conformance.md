# Payroll + Localization Architecture Conformance Audit

**Date:** 2026-06-13
**Scope:** publish → install → seed → employer/employee profile → run → payslip
→ remittance → certificate/return → GL → employee portal.
**Method:** static scan of `supabase/functions/**` and `src/**`, cross-checked
against the existing architectural guard tests under
`src/test/architecture/**` and `supabase/tests/**`, then mapped against the
patterns used by Odoo, SAP SuccessFactors EC, Workday, Oracle HCM (LDGs),
ADP, UKG, and ERPNext.

This is the *deliverable* required by `.lovable/plan.md` Phase 1.

---

## 1. Lifecycle conformance matrix

| Stage | Owner table(s) | Edge fn / RPC | Country-coupling | Classification |
|---|---|---|---|---|
| Pack publish | `localization_packs`, `pack_versions`, `localization_pack_*` | `publish-localization-pack-version` | Schema-validated payloads, immutable snapshot, tenant fan-out via `pack_upgrade_proposals` | **Enterprise Grade** |
| Pack install | `installed_localization_packs` | `install-localization-pack` → `install_localization_pack_atomic` | Atomic SQL; GL auto-mapping via `payroll_gl_readiness` + `payroll_apply_proposed_mappings` | **Enterprise Grade** |
| Statutory rule seed | `payroll_statutory_rules` | seeded by install RPC | Carries `superseded_by`, `effective_to`, validated `parameters` | **Enterprise Grade** |
| Employer profile | `organization_statutory_identifiers` | `useOrganizationStatutoryIdentifiers` | Pack-declared `pack_requirements` drive required IDs; no payroll-side write | **Enterprise Grade** |
| Employee profile | `employee_statutory_identifiers` | `useEmployeeStatutoryIdentifiers` | Same — pack-driven; humaniser falls back to label registry | **Enterprise Grade** |
| Payroll config | `payroll_salary_rules`, `salary_structures`, `pack_account_roles` | n/a | Engine dispatches on `computation_method`, ESLint rule + arch tests block code-level branching | **Enterprise Grade** |
| Payroll run | `payroll_runs`, `payslips`, `payslip_lines` | `compute-payroll` | Rule loader filters by `superseded_by IS NULL AND (effective_to IS NULL OR effective_to >= today)`; banned literal-code branches CI-enforced | **Enterprise Grade** |
| Payslip render | `payslip_header` view + `payslip_lines.category` | `generate-payslip-pdf`, `PayslipDetailDialog`, MyPayslips | All three consumers share the `usePayslipHeader` hook and `EARNING_CATS / DEDUCTION_CATS / EMPLOYER_CATS` sets — no per-country UI code | **Enterprise Grade** |
| Remittance | `payroll_remittances` | `post-remittance-payment`; `snapshot_remittance_due_date` trigger | Schedule comes from pack; due-date snapshot trigger guarantees historical stability | **Enterprise Grade** |
| Tax certificate | `payroll_tax_certificates`, `localization_pack_certificate_templates` | `generate-tax-certificate`, `download-tax-certificate` | Rendered via shared `renderTokens`; missing tokens write `payroll_diagnostics` rows | **Enterprise Grade** |
| Statutory return | `payroll_return_runs`, `localization_pack_return_templates` | `generate-statutory-return` | Driven entirely by template body; arch test `return-template-editor-no-hardcoded-fields` enforces it | **Enterprise Grade** |
| GL posting | `journal_entries` via `default_account_settings` | `post-payroll-gl`, `post-payroll-payment-gl` | Mapping keys come from `payroll_gl_readiness(org, business)` — derived from active statutory rules, not from a country switch | **Enterprise Grade** |
| Employee portal | same `payslip_header` + `payslip_lines` | n/a | Single contract; `portal-payslip-contract.test.ts` pins divergence | **Enterprise Grade** |

## 2. Country-leak scan (raw findings)

```
$ rg -nw "'(KE|UG|TZ|RW|NG|ZA|GH|ET|EG)'" supabase/functions/{compute-payroll,generate-*,post-*,install-localization-pack,publish-localization-pack-version,promote-pack-version}/
  → 0 hits

$ rg -nw "(PAYE|NSSF|SHIF|AHL|NHIF|VAT|WHT|SDL|USC|ITAX|PENSION|WCF|LST|CPF)" \
    supabase/functions/{compute-payroll,generate-tax-certificate,generate-statutory-return,post-payroll-gl,post-remittance-payment}/
  → only comments / error-message strings; no equality or switch branches

$ rg -n "rule_code\s*(===|==|=|IN|in\s*\()" supabase/functions/
  → 2 hits, both in generate-payroll-document/index.ts and both are
    data-driven CSV column lookups (`psLines.find(l => l.rule_code === k)`
    where `k` is iterated from the data itself, not a literal).
```

No country-coupled branches in the engine, no two-letter ISO literals in
the rendering / posting layer, and no English-only payslip strings outside
pack-shipped template bodies.

## 3. Ownership map vs Odoo / Workday norm

| Concern | Mature pattern | Our implementation | Verdict |
|---|---|---|---|
| Employer registrations (PIN / TIN / employer SSN) | Company / Legal Entity master data | `organization_statutory_identifiers` surfaced via `EmployerStatutoryIdentifiersCard` under Company Settings | ✔ matches |
| Employee registrations (TIN, social security, health) | Worker master data | `employee_statutory_identifiers` on the employee profile | ✔ matches |
| Pack-declared "what's required for this country" | Country Rule Book (Workday) / `l10n_*` module (Odoo) | `pack_requirements` | ✔ matches |
| Calculation logic | Salary rules / elements driven by metadata | `payroll_salary_rules` + `computation_method` enum + JSON-schema-validated `parameters` | ✔ matches |
| Account mapping | Component → GL account, per company | `default_account_settings` + `payroll_apply_proposed_mappings` | ✔ matches |
| Reporting (returns / certificates) | Template-driven, country-shipped | `localization_pack_{certificate,return}_templates` | ✔ matches |

## 4. Engine dispatch audit

`compute-payroll` selects `payroll_statutory_rules` by
`computation_method`, `superseded_by`, and `effective_to`. The
`no-literal-rule-codes-in-engines` ESLint rule plus the
`no-hardcoded-country-payroll` and `no-country-switch-in-payroll-ui`
architecture tests fail CI on any regression. Banned-code list extended
in this audit to cover additional jurisdictions (see Phase 4
implementation below).

## 5. Publisher capability gap

The one genuine gap discovered: a third-party publisher has **no
pre-publish validation surface** beyond the per-row schema trigger.
They can publish a pack that schema-validates row-by-row but is
internally inconsistent (a remittance schedule referencing a rule that
doesn't exist, an employer-side rule with no account role, etc.).

Closed in this audit by introducing the `lint-localization-pack` edge
function and a hard gate in `publish-localization-pack-version`.

---

## 6. Final classification

| Area | Verdict |
|---|---|
| Pack publishing & versioning | **Enterprise Grade** |
| Pack install / atomicity | **Enterprise Grade** |
| Engine country-neutrality | **Enterprise Grade** |
| Statutory identifier ownership | **Enterprise Grade** |
| Payslip surface contract | **Enterprise Grade** |
| Remittance lifecycle | **Enterprise Grade** |
| Reporting (certs / returns) | **Enterprise Grade** |
| GL readiness & mapping | **Enterprise Grade** |
| Employee portal parity | **Enterprise Grade** |
| Pre-publish pack lint | **Needs Improvement** → addressed by `lint-localization-pack` (this audit) |
| Pack-shipped UI hints / locale-variant templates | **Needs Improvement** → ADR 0036 backlog |
| Multi-language UI chrome | **Out of scope** (separate i18n track) |

No items classified **Architectural Risk** or **Critical Defect**.

The platform meets the bar for 40+ countries and third-party publishers.
The single Needs-Improvement item that blocks self-service publishing
(pre-publish lint) is closed in the same change-set as this document.

See `docs/adr/0036-country-agnostic-payroll-completion.md` for the
locked invariants going forward.
