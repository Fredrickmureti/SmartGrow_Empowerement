
## Verification of the previous agent's work

Independently traced against the codebase (not the agent's notes):

- **§R1 (dual deductibility encoding).** Implemented at `supabase/functions/compute-payroll/index.ts` lines 2543–2569. `isDeductible` unions `parameters.reduces_taxable_income === true` with the `pre_tax_deductions[]` set built from every `income_tax` rule. Verified against the live KE pack row in `payroll_statutory_rules`: PAYE carries `pre_tax_deductions=[nssf, shif, housing_levy, pension_contribution, mortgage_interest, post_retirement_medical]`, and NSSF/SHIF/AHL rule_codes match, so Pass A now reduces the base by 5,640 + 2,585 + 1,410 = 9,635 for the reference payslip. **Correct.**
- **§R2 (declarative reliefs).** `computeBracketProgressive` (lines 290–342) iterates `parameters.reliefs[]` and honours `kind ∈ {flat, rate_of_base}`, dedupes against the scalar `personal_relief` / `insurance_relief_*` fields, and applies the `condition` gate off `ctx.inputs`. **Partial — see gap A below.**
- **§R3 (explainer surface).** Engine attaches `bracket_breakdown`, `taxable_base`, `taxable_base_components`, `gross_tax`, `personal_relief`, `insurance_relief`, `final_tax`, `legal_basis` to `payslip_lines.source` for every bracket_progressive line (lines 3285–3306). `breakdownAdaptor.ts` renders taxable-base build-up + relief subnotes. `generate-payslip-pdf/index.ts` (lines 414–430) prints them under the PAYE row, gated by `pdf_show_explainer`. React-side `PayslipLineExplainer` popover consumes the same adaptor. **Correct.**
- **§R4 (arch tests).** `paye-pre-tax-deductions.test.ts` and `paye-explainer.test.ts` pin the engine contract + adaptor output. **Correct.**
- **§R5 (correction run for already-committed payslips).** **Not started.**
- **Housekeeping migration + schema guard on `pack_rule_type_schemas`.** **Not started.**
- **Persisted `payslips.taxable_base` / `payslips.paye_before_relief`.** **Not started.**

### New gaps found while auditing

- **Gap A — reliefs pipeline is a strict subset of the pack contract.** `kind ∈ {deduction_cap, exemption}` are declared TODO in the engine (`index.ts:338–342`). The KE pack ships three reliefs that depend on these paths: `ahr_relief` (rate_of_base but needs `ctx.inputs.ahr_contribution`), `mortgage_interest_cap` (kind=deduction_cap, cap 30,000), and `disability_exemption` (kind=exemption, 150,000). None fire today.
- **Gap B — `EMPLOYEE_INPUT_REGISTRY` (`index.ts:196`) only exposes `insurance_premium`.** `ahr_contribution`, `mortgage_interest`, `pension_contribution`, `post_retirement_medical`, and the `disability_certified` gate flag are never resolved into `ctx.inputs`, so every relief that references them silently no-ops. This is why the previous agent's claim "ahr_relief automatically applies" is not actually reachable today.
- **Gap C — the deductibility contract can silently drift.** Nothing in `pack_rule_type_schemas` forbids a pack from omitting BOTH `pre_tax_deductions[]` on the tax rule AND `reduces_taxable_income=true` on siblings. That is exactly how KE drifted before.
- **Gap D — the reference tenant's committed payslip (net 63,782.26, PAYE 20,582.80) was produced on the pre-fix engine.** Recomputing silently would rewrite history and desync `payroll_liabilities`, P9A YTD, and any already-remitted PAYE. ADR-0045's correction-delta engine exists specifically for this.

## Remaining work

### 1. Finish the reliefs pipeline (Gap A)

Extend `computeBracketProgressive` and Pass A so every `reliefs[]` kind the schema allows is actually honoured:

- `kind='exemption'` → treated as a taxable-base reduction, applied in Pass A alongside `pre_tax_deductions`. Guarded by its `condition` (e.g. `disability_certified`). Contributes a row to `taxable_base_components` as `-150,000` so the explainer shows it.
- `kind='deduction_cap'` → looked up during Pass A. When a deductible sibling rule matches `base_code` (e.g. `mortgage_interest`), the amount added to `statutoryDeductible` is `min(rule_amount, cap)`. Cap breach is surfaced as a subnote on the payslip line.
- `kind='rate_of_base'` with a `condition` → already routed correctly, but only fires once inputs are populated (see step 2).

Each applied relief becomes its own subnote in `bracket_trace` so the explainer keeps a per-relief audit trail.

### 2. Register the missing statutory inputs (Gap B)

Extend `EMPLOYEE_INPUT_REGISTRY` and the pre-fetch pass (mirroring how `insurance_premium` is aggregated from `contract_compensation_components`) to expose:

| Token | Source |
|---|---|
| `ahr_contribution` | `contract_compensation_components` where `component_code='ahr_contribution'` |
| `mortgage_interest` | `contract_compensation_components` where `component_code='mortgage_interest'` |
| `pension_contribution` | `contract_compensation_components` where `component_code='pension_contribution'` |
| `post_retirement_medical` | `contract_compensation_components` where `component_code='post_retirement_medical'` |
| `disability_certified` | `employee_statutory_identifiers` boolean flag (or dedicated column) |

Country-agnostic: registry keys are token names, not country literals. Packs from other countries pick these up automatically once they reference the same base_codes.

### 3. Persist `taxable_base` and `paye_before_relief` on `payslips`

Migration adds two `numeric(18,2)` columns to `public.payslips` (GRANTs unchanged — inherits table grants). Engine writes them alongside `taxable_income`. Reports, tax certificates and the PDF stop having to re-derive them from `payslip_lines.source`.

### 4. Canonicalise the deductibility contract (Gap C)

- Migration: back-fill `reduces_taxable_income=true` onto all sibling statutory rules referenced by any live `income_tax.pre_tax_deductions[]`. Keeps the pack encoding intact for authoring, but the engine's imperative form becomes authoritative.
- `pack_rule_type_schemas` guard on `income_tax`: at publish time, require every `pre_tax_deductions[]` entry to reference an active same-org rule_code AND require that rule to carry `reduces_taxable_income=true`. This closes the drift path.
- pgTAP test in `supabase/tests/` pins the guard.

### 5. ADR-0045 correction slice for the affected payslip(s)

For committed KE payslips computed on the wrong base:

- `payroll_correction_adjustments` row per affected payslip line (PAYE delta, net-pay delta).
- Correction JE via `payroll_generate_reclassification_je` shape (mirror ADR-0022 pattern) — debit `paye_payable`, credit `salary_expense`. Idempotent on `payroll_runs.correction_journal_entry_id`.
- P9A YTD is re-derived from `payroll_employee_ytd` after the adjustment lands, so tax certificates for the affected year stay reconciled.
- Surfaced in the payroll UI as a "Recomputation required" banner on the run detail; nothing is rewritten silently.

### 6. Integrity tests

- `src/test/payroll/reliefs-full-kinds.test.ts` — deduction_cap actually caps mortgage_interest at 30,000; exemption reduces taxable base by 150,000 only when the condition input is truthy.
- `src/test/payroll/employee-input-registry.test.ts` — every base_code / condition referenced by shipped packs resolves through the registry (fails the build when a pack adds a token the engine can't feed).
- `supabase/tests/pack_income_tax_deductibility.sql` — pgTAP: every `pre_tax_deductions[]` entry references an active same-org rule flagged `reduces_taxable_income=true`.

## Technical notes

- No changes to `payslip_lines` schema — the explainer payload already lives on `.source`.
- `post-payroll-gl`, `generate-statutory-return`, `generate-tax-certificate` need no code changes; they consume totals that flow through automatically. The correction slice writes the delta via the existing ADR-0022 helper.
- The engine stays country-agnostic: every new behaviour dispatches off `parameters.*` and `EMPLOYEE_INPUT_REGISTRY` tokens. `eslint-rules/no-literal-rule-codes-in-engines.js` continues to block literal country checks.
- Existing arch guards (`no-regex-on-readiness-rule-codes`, `payroll-ui-statutory-data-driven`, ADR-0036 country-agnostic completion) all remain satisfied.

## Out of scope

- New country packs.
- Pack editor UI redesign — schema tightening is enough; the editor's SchemaForm inherits it.
- Employee-portal payslip UI beyond the existing `PayslipLineExplainer` popover.
