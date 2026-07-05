
# Enterprise Payroll Audit — PAYE Computation & Payslip Explainability

## 1. Executive finding

The PAYE of **KES 20,582.80** on the payslip is arithmetically consistent with the engine, but the engine is **taxing the wrong base**. It taxes on **gross (94,000)** instead of **gross − allowable statutory deductions (84,365)**. The over-charge is ~KES 2,890/month per employee.

Reproduction against the shipped Kenya pack:

```text
Gross                       94,000.00
Bands on 94,000 (WRONG):
  0–24,000       @10%        2,400.00
  24,001–32,333  @25%        2,083.25
  32,334–94,000  @30%       18,500.10
  Sub-total                 22,983.35
  − Personal relief          2,400.00
  = PAYE                    20,583.35  ← matches payslip (rounding 20,582.80)

Correct (Finance Act 2023 + TLAA 2024):
  Taxable = 94,000 − NSSF 5,640 − SHIF 2,585 − AHL 1,410 = 84,365
  Bands on 84,365           20,092.85
  − Personal relief          2,400.00
  = PAYE                    17,692.85
Discrepancy                  ~2,890.50
```

This is **not a formula bug**. It is an **architectural contract mismatch** between what the localization pack declares and what the engine consumes.

## 2. Root cause — two competing conventions for "deductibility"

The Kenya PAYE rule (`payroll_statutory_rules.rule_code='paye'`) declares deductibility **declaratively, on the PAYE rule itself**:

```json
"parameters": {
  "pre_tax_deductions": ["nssf","shif","housing_levy","pension_contribution","mortgage_interest","post_retirement_medical"],
  "personal_relief": 2400,
  "insurance_relief_rate": 15,
  "insurance_relief_max": 5000,
  "reliefs": [
    {"code":"personal_relief","kind":"flat","amount":2400},
    {"code":"insurance_relief","kind":"rate_of_base","base_code":"insurance_premium","rate":0.15,"cap":5000},
    {"code":"ahr_relief","kind":"rate_of_base","base_code":"ahr_contribution","rate":0.15,"cap":9000},
    {"code":"mortgage_interest_cap","kind":"deduction_cap","base_code":"mortgage_interest","cap":30000},
    {"code":"disability_exemption","kind":"exemption","amount":150000}
  ],
  "employer_must_apply_reliefs": true
}
```

The engine (`supabase/functions/compute-payroll/index.ts`, lines ~2482–2533) reads deductibility **imperatively, on each sibling rule**:

```ts
const isDeductible = (r) => r.parameters?.reduces_taxable_income === true;
```

The NSSF, SHIF, and AHL rows in `payroll_statutory_rules` **do not carry `reduces_taxable_income: true`**. Therefore Pass A is empty, `statutoryDeductible = 0`, and `ctx.taxableIncome` stays at gross. Only `personal_relief` and `insurance_relief_rate/max` (which are readable off the PAYE row and therefore work) are applied.

**The pack and the engine encode the same fact in two different places, and neither side reads the other.** The pack's `pre_tax_deductions` array and full `reliefs[]` array are effectively dead data.

## 3. Where the architecture is (and isn't) sound

**Sound**
- `payroll_statutory_rules` is genuinely the source of truth; there is no shadow tax table (`calculate_kenya_paye` is retired and blocked by `supabase/tests/no_country_named_functions_test.sql`).
- The engine dispatches off `computation_method` (`bracket_progressive`, `tiered_brackets`, `percentage_of_gross`, `flat_amount`) with an ESLint guard (`eslint-rules/no-literal-rule-codes-in-engines.js`) — no `if(code==='PAYE')` branches.
- Pack schema validation (`pack_rule_type_schemas` + `trg_assert_pack_payload_valid`) exists (ADR 0010).
- Bracket-progressive traces (`payroll_rule_traces` + `taxable_base_components` annotation at lines 2598–2611) are already emitted per employee, ready to power an explainer.
- Provenance (`payslip_lines.source.input_ref`, ADR 0046) already ties payslip lines to originating business records.

**Broken / drifting**
- The pack expresses fiscal semantics (`pre_tax_deductions`, `reliefs[]`) that the engine ignores.
- Reliefs are a strict subset: only `personal_relief` (flat) and `insurance_relief` (rate_of_base) are honoured. `ahr_relief`, `mortgage_interest_cap`, `disability_exemption` are silently dropped.
- The payslip PDF (`generate-payslip-pdf/index.ts`) prints totals from `payslip_lines` but does **not** render the PAYE bracket trace, taxable-base composition, or relief breakdown that the engine already computed and persisted. Explainability data exists; the document layer discards it.
- `employer_must_apply_reliefs: true` is metadata the engine has no handler for.

## 4. Pipeline as-built (business events)

```text
Contract / SalaryStructure
        │
        ▼
Salary components  ──► Gross pay
        │
        ▼
[Pass A]  rules where parameters.reduces_taxable_income=true
        │   ⚠ pack encodes this in PAYE.parameters.pre_tax_deductions instead → Pass A is empty
        ▼
Taxable base = Gross − Σ(Pass-A employee amounts) − housing_exempt
        │
        ▼
[Pass B]  income_tax rule (bracket_progressive on ctx.taxableIncome)
        │  ── applies personal_relief (scalar)
        │  ── applies insurance_relief (rate/cap)
        │  ⚠ other reliefs in parameters.reliefs[] are ignored
        ▼
PAYE  ──► payslip_lines(kind='deduction', input_ref=…)
        │  bracket trace persisted to payroll_rule_traces
        ▼
Payslip PDF prints total only; trace never rendered
        │
        ▼
GL post ──► Remittances ──► Tax certificates
```

## 5. Payslip information-architecture gap

Current payslip surfaces: gross, PAYE, statutory deductions, employer contributions, net. Enterprise-grade layers that exist in data but not on the document:

| Layer | Data source (already present) | Rendered? |
|---|---|---|
| Basic + allowance breakdown | `payslip_lines` category=earning | Partial |
| Pre-tax deductions block | `payslip_lines` where source rule is deductible | No |
| Taxable pay | `payslips.finalTaxableBase` (persisted at 2480) | No |
| PAYE bracket breakdown | `payroll_rule_traces.brackets[]` | No |
| Taxable-base composition | `taxable_base_components` on trace | No |
| Reliefs applied (line items) | `bracket_trace.personal_relief`, `insurance_relief` | No |
| Employer cost total | `contributionsDetail` | No |
| Legal basis / rule reference | `rule.parameters.legal_basis` | No |
| YTD roll-forward | `payroll_employee_ytd_rollup` RPC | No |

## 6. Redesign — remediation plan

### R1. Make the pack the single source of truth for deductibility (engine change, no pack edit)

Extend the Pass-A predicate in `compute-payroll/index.ts` to honour **both** encodings:

```ts
// Build the deductibility set from the income_tax rule's declarative list.
const paye = empRules.find(r => r.rule_type === 'income_tax');
const preTaxCodes = new Set<string>(
  ((paye?.parameters as any)?.pre_tax_deductions ?? []) as string[]
);
const isDeductible = (r: PayrollRule) =>
  (r.parameters as any)?.reduces_taxable_income === true
  || preTaxCodes.has(r.rule_code);
```

This keeps ADR 0036 country-agnostic (dispatch stays off `parameters`, not literals) and lets every existing pack — Kenya included — work without a data migration. A follow-up housekeeping migration should normalise: either back-fill `reduces_taxable_income=true` onto NSSF/SHIF/AHL, or drop `pre_tax_deductions` from the PAYE row. Pick **one** and enforce it in the schema (`pack_rule_type_schemas`) so future packs cannot re-drift.

### R2. Promote reliefs to a first-class engine construct

Replace the hard-coded `personal_relief` / `insurance_relief_*` scalar reads inside `bracket_progressive` with a generic reliefs pipeline driven by `parameters.reliefs[]`:

```text
computeReliefs(reliefs[], ctx) →
  for each relief:
    kind='flat'          → subtract amount
    kind='rate_of_base'  → min(base * rate, cap)
    kind='deduction_cap' → cap the corresponding pre-tax deduction upstream
    kind='exemption'     → subtract amount from taxable base (Pass A)
  returns { total_relief, per_relief_lines[] }
```

Each applied relief becomes its own `payslip_lines` row with `input_ref = { kind: 'statutory_rule', rule_code, relief_code }`. The scalar path stays as a fallback for packs that haven't migrated yet.

### R3. Persist and expose the taxable-base and PAYE explainer

The engine already computes `finalTaxableBase` and annotates `taxable_base_components` on the bracket trace. Two additions:

1. Persist `taxable_base` and `paye_before_relief` on `payslips` (new columns; migration required).
2. `generate-payslip-pdf` gains an "How PAYE was computed" section that renders:
   - taxable-base build-up (Gross − NSSF − SHIF − AHL − housing_exempt − pension …)
   - each bracket row (band, rate, taxable-in-band, tax-in-band)
   - each relief line
   - final PAYE, with the legal basis footnote from `rule.parameters.legal_basis`

This data already lives in `payroll_rule_traces`; the PDF just has to join and render it. No engine changes needed for this bullet.

### R4. Country-agnostic architecture tests

Add:

- pgTAP test: every `income_tax` rule with a non-empty `pre_tax_deductions[]` must reference `rule_code`s that exist as active statutory rules for the same org.
- Vitest arch test: `generate-payslip-pdf` imports `payroll_rule_traces` (fails the build if the explainer section is deleted).
- Schema test: `pack_rule_type_schemas` for `income_tax` must require **either** `pre_tax_deductions[]` on the tax rule **or** `reduces_taxable_income=true` on siblings — never both, never neither.

### R5. Downstream verification (out of the payroll module)

- **GL**: `post-payroll-gl` reads per-line amounts; if PAYE drops from 20,582 → 17,692, the credit to `paye_payable` and the debit to `salary_expense` net move in lockstep — no mapping change needed. Confirm by running readiness (`payroll_gl_readiness`) before and after remediation.
- **Remittances / P10**: `generate-statutory-return` reconciles against `payroll_liabilities.original_amount`. Because liabilities are derived from payslip totals, the corrected figure flows through automatically.
- **Tax certificate (P9A)**: `generate-tax-certificate` uses `payroll_employee_ytd_rollup`. YTD reflects the corrected monthly PAYE from that point forward. Historical over-charged months are **not** silently rewritten — they must be handled via ADR 0045's correction-delta engine so the audit trail is preserved.

## 7. Deliverables for the implementation slice

1. Engine patch (§R1) with a unit test that reproduces the 84,365 taxable base and 17,692.85 PAYE against the shipped KE pack — no pack edit required.
2. Reliefs pipeline (§R2) + tests covering `ahr_relief`, `mortgage_interest_cap`, `disability_exemption`.
3. Payslip PDF explainer section (§R3) + migration for `taxable_base`, `paye_before_relief` on `payslips`.
4. Architecture tests (§R4).
5. Correction run (ADR 0045) to remediate any already-committed KE payslips computed on the wrong base, so remittances and P9A stay consistent.
6. Housekeeping migration to collapse the two deductibility conventions into one, plus a `pack_rule_type_schemas` guard so this drift cannot recur.

## 8. What is explicitly out of scope for this slice

- Redesigning the pack editor UI. The pack schema is already correct; the engine has to catch up.
- Introducing new country packs. The remediation is generic; new packs benefit automatically once §R1/§R2 land.
- Employee-portal payslip UI beyond what the PDF already exposes — the drill-down resolver (ADR 0046) is already wired for the bracket rows once they render.
