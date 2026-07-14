# NSSF "VOLUNTARY" — architectural diagnosis + fix

## 1. What "Voluntary" on the NSSF return actually is

Per the NSSF Act No. 45 of 2013 and NSSF's own e-return file spec, the monthly employer return has three contribution-type rows:

- `101` — Tier I (mandatory, 6% + 6% up to LEL)
- `102` — Tier II (mandatory, 6% + 6% between LEL and UEL)
- **`105` — Voluntary Contributions** — a flat top-up above the tiers, **opt-in by the employee**, initiated via NSSF's *Voluntary Member Contributions Monthly Check-Off System* form. The employer only remits it when the employee has signed the check-off authorization; there is **no statutory obligation** to deduct or populate it for other employees.

Enterprise payroll systems (Odoo `l10n_hr_kenya`, Workday, SAP SuccessFactors, Oracle HCM, Dynamics 365) all model Type-105 the same way: **an opt-in, per-employee recurring flat deduction**, never a computed statutory percentage. The column is left blank/zero unless a specific employee has a standing check-off.

## 2. What our architecture currently does

Verified against the live DB and code (not just seed migrations — the current NSSF_RET row was later edited to KRA's real byproduct layout):

`localization_pack_return_templates` row `NSSF_RET`, column `voluntary`, source:

```
sum_rule.nssf_voluntary.employee
```

Resolver contract (`supabase/functions/_shared/returnSourceResolver.ts:44,94-112,156-169`): `sum_rule.<code>.<side>` sums `payslip_lines.employee_amount` (or `employer_amount`) where `rule_code = <code>`, and `<code>` is auto-added to the payslip_lines fetch via `extractExtraRuleCodes`. Unknown codes silently return 0 (line 182), which is why the column renders blank instead of failing.

What produces `payslip_lines`:

- `payroll_statutory_rules` — has `nssf` only, no `nssf_voluntary`.
- `payroll_rule_types` — same.
- `pack_token_registry` — has `employee.tier3_voluntary_employee/employer` (Ghana precedent, ADR 0010 Amendment) but nothing for Kenya voluntary.
- `payroll_input_types` / `payslip_inputs` — no `nssf_voluntary` input.
- `salary_components` — none.
- `employee_custom_deductions` — general path that *does* reach payslips, but `compute-payroll/index.ts:3631-3651` emits those lines with `rule_code = "custom_" + cd.code`, so a pack column source of `sum_rule.nssf_voluntary.employee` would need to be `sum_rule.custom_nssf_voluntary.employee` to match — and that prefix is an engine-internal convention, not something a pack template should hard-code.

Employee Profile: consistent with your description — only pack-published statutory *identifiers* (KRA PIN, NSSF No., SHIF, AHL Ref) via `employee_statutory_identifiers` and dynamic `entity_field_configs`. No amount fields.

**Diagnosis (single sentence):** the Kenya pack publishes a return column that reads `sum_rule.nssf_voluntary.employee`, but no rule, input, token, or deduction in the tenant produces payslip lines with `rule_code = 'nssf_voluntary'`. The column is architecturally orphaned. This is **not a data-entry bug**, **not a template bug** (Type 105 is legitimately part of the return), and **not a missing employee field** (Type 105 is a recurring amount, not an identifier). It is a **pack↔engine wiring gap**: the pack declares a rule-code source without publishing the corresponding rule.

## 3. Where the fix belongs (architecture answer)

Wrong homes and why:

- ❌ Employee Profile statutory field → Type-105 is a *monthly amount* per active check-off, not an identifier. Never modeled this way in enterprise systems.
- ❌ Hard-coded engine branch for `nssf_voluntary` → breaks country-agnosticism (also fails `no-hardcoded-country-payroll.test.ts`, `no-country-named-functions_test.sql`).
- ❌ New bespoke `nssf_voluntary_contributions` table → duplicates the existing recurring-deduction ownership already held by `custom_deduction_types` + `employee_custom_deductions`, contradicts ADR 0005/0022 module-ownership discipline.
- ❌ New `payroll_input_types` entry keyed per period → misrepresents a *standing* check-off as an ad-hoc input; also unenrollable, no GL mapping, no lifecycle.

Right home: the existing **`custom_deduction_types` / `employee_custom_deductions`** surface — which already carries amount, schedule, GL liability mapping, employer-vs-employee flag, and payslip integration — **plus a pack-declared identity** that ties a specific deduction type to a specific pack rule code, so the pack template can bind to it *without* leaking the engine's `custom_` prefix.

This mirrors the Ghana Tier-3 precedent (ADR 0010 Amendment 2 — `EMPLOYEE_INPUT_REGISTRY` unions pack-registry tokens with built-ins), extended one level down from *tokens* to *rule codes emitted on payslip lines*.

## 4. Proposed change (minimal, pack-driven, no country code in engine)

### 4.1 Pack-level: declare voluntary deduction slots

Add a nullable column `payroll_rule_code TEXT` to `custom_deduction_types`. When set, the compute-payroll custom-deduction emitter uses that as the `rule_code` on the payslip line (and in metadata) instead of `custom_<code>`. Uniqueness constraint per organization on `(pack_id, payroll_rule_code)` so packs can seed prototypes without colliding with tenant-created deductions.

Semantics: this is the **general** hook — any pack can declare "this deduction, if the tenant installs and configures it, feeds return column X via rule code Y." Not Kenya-specific.

### 4.2 Kenya pack seed (migration)

Insert (idempotent) a Kenya-owned `custom_deduction_types` template row:

- `code = 'nssf_voluntary'`
- `payroll_rule_code = 'nssf_voluntary'`
- `is_employer_contribution = false` (employee side; a second row will be added if/when we support employer top-up)
- `pre_tax = false` (Type-105 is post-tax; PAYE relief for Tier-3 style pension is separate)
- GL mapping wired to the existing pack default account role `tier3_payable` (already seeded in migration `20260707215652`) so no new GL role is introduced
- `pack_id` = Kenya pack

Tenant activation stays a manual HR action (matches the real business event: employee submits the NSSF check-off form → HR creates the `employee_custom_deductions` row with the amount and start date). No auto-enrollment.

### 4.3 Engine: single-line change in `compute-payroll`

In the custom-deduction loop (`supabase/functions/compute-payroll/index.ts:3631`):

```ts
const emittedCode = cd.payroll_rule_code ?? `custom_${cd.code}`;
pushLine(emittedCode, ..., emittedCode, ...);
```

Country-agnostic. Legacy custom deductions unchanged (fall through the `??`).

### 4.4 Return template resolver: no change

`sum_rule.nssf_voluntary.employee` will now naturally match the emitted line. `extractExtraRuleCodes` already adds `nssf_voluntary` to the payslip_lines fetch.

### 4.5 Pack tokens (nice-to-have, non-blocking)

Register `employee.nssf_voluntary_amount` in `pack_token_registry` (source = `employee_custom_deduction`) for future certificate/payslip templates that want the per-payslip amount inline. Follows the Ghana Tier-3 precedent exactly.

### 4.6 UI

Nothing new to build:

- Finance → Default Accounts already exposes `tier3_payable` (guard-protected per ADR 0022).
- HR → Employee → Deductions (existing `CustomDeductionDialog`) is the enrollment surface. Kenya tenants will see the pack-seeded `nssf_voluntary` deduction type in the picker; HR fills in the monthly amount and effective dates from the signed NSSF check-off form.
- Payslip already renders custom-deduction lines through the existing classifier (`voluntary_deduction` classification already exists in `payslipClassifier.ts:27`).
- Compliance / Returns → NSSF Monthly Byproduct Return will now render populated `VOLUNTARY` cells for employees with an active `nssf_voluntary` deduction, and zero for everyone else (which is the correct enterprise behavior).

## 5. Lifecycle answers (Business Events 1–5)

1. **Employee joins** → identifiers only (KRA PIN, NSSF No., SHIF No., AHL Ref) via pack-driven statutory fields. **No voluntary field collected.**
2. **Payroll processes** → NSSF Tier I + Tier II always via `payroll_statutory_rules('nssf')`; Type-105 amount comes exclusively from an active `employee_custom_deductions` row linked to the pack-seeded `nssf_voluntary` type. Never manual entry in payslip inputs, never derived from gross.
3. **Employee opts in to top-up** → signs NSSF Voluntary Member Contributions Monthly Check-Off form. HR (not payroll officer, not finance) receives the form and creates the `employee_custom_deductions` row with the monthly amount, start date, and optional end date. The system of record is HR.
4. **Where it lives** → `custom_deduction_types` (pack-seeded template) + `employee_custom_deductions` (tenant enrollment). Not identifiers, not a separate NSSF config table, not benefits (Kenya NSSF voluntary is not modeled as an employer benefit plan).
5. **What it affects** → payslip line (visible under Voluntary Deductions), employee net pay (post-tax reduction), employer NSSF liability row 105 (via existing `payroll_liabilities` + `tier3_payable` GL), NSSF byproduct return VOLUNTARY column. **Does not affect** PAYE computation, insurance relief, personal relief, or employer statutory expense — Type-105 is entirely between employee and NSSF; employer facilitates the check-off only.

## 6. Testing

Add an architecture test asserting:

- Every `localization_pack_return_templates` column whose source matches `sum_rule\.(.+)\.(employee|employer)` has *either* a `payroll_statutory_rules.rule_code` OR a `custom_deduction_types.payroll_rule_code` (or a `payroll_salary_rules.rule_code`) that could produce it, in the same pack. Prevents future orphan columns in any pack, not just Kenya.

Add an integration test for `compute-payroll`: employee with an `employee_custom_deductions` row linked to a `custom_deduction_types` row where `payroll_rule_code='nssf_voluntary'` → resulting payslip has a line with `rule_code='nssf_voluntary'` and the NSSF return VOLUNTARY column sums correctly.

## 7. Non-goals / explicitly out of scope

- Employer-side voluntary top-up (rare; add a second Kenya-pack row later if a tenant requires it).
- Reworking NSSF Tier-I/II — those work today.
- Backfilling historic returns — historic payslips have no voluntary lines, so historic returns will continue to render 0 in the column (correct).
- Any change to the country-agnostic engine beyond the single-line `emittedCode` swap.

## Technical summary

- **Schema:** `ALTER TABLE public.custom_deduction_types ADD COLUMN payroll_rule_code TEXT NULL;` + partial unique index on `(pack_id, payroll_rule_code) WHERE payroll_rule_code IS NOT NULL`. No RLS changes (rows are pack-owned or org-owned exactly as today; grants unchanged).
- **Engine:** `supabase/functions/compute-payroll/index.ts` — one-line change to derive `emittedCode` from `payroll_rule_code ?? "custom_" + code`.
- **Kenya pack seed migration:** idempotent insert of a `custom_deduction_types` row `nssf_voluntary` with GL mapping to `tier3_payable`.
- **Pack token registry:** one row for `employee.nssf_voluntary_amount` (optional, for future templates).
- **Architecture test:** `src/test/architecture/return-template-columns-have-source.test.ts` — pattern-matches every `sum_rule.*` source in every pack against declared producers.
- **Compute-payroll test:** exercises the end-to-end flow with a synthetic pack + tenant.
