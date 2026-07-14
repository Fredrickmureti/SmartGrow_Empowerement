-- Slice 1: schema — pack-linked rule code on tenant custom deduction types.
ALTER TABLE public.custom_deduction_types
  ADD COLUMN IF NOT EXISTS payroll_rule_code TEXT NULL;

COMMENT ON COLUMN public.custom_deduction_types.payroll_rule_code IS
  'Optional pack-declared rule code emitted on payslip_lines / return contexts. When NULL, the engine falls back to "custom_" || code (legacy behaviour). When set, this string is used verbatim as payslip_lines.rule_code so localization pack return templates and tokens can bind to a stable pack-owned code (e.g. Kenya NSSF Type-105 "nssf_voluntary").';

-- Uniqueness per tenant so a tenant cannot bind two deduction types to the same pack rule code.
CREATE UNIQUE INDEX IF NOT EXISTS ux_custom_deduction_types_business_rule_code
  ON public.custom_deduction_types (business_id, payroll_rule_code)
  WHERE payroll_rule_code IS NOT NULL;

-- Slice 2: light guardrails — rule codes must be lowercase snake_case, non-empty, and
-- must not collide with the reserved "custom_" engine-internal prefix (which would
-- defeat the whole purpose of the field).
ALTER TABLE public.custom_deduction_types
  DROP CONSTRAINT IF EXISTS custom_deduction_types_payroll_rule_code_format;

ALTER TABLE public.custom_deduction_types
  ADD CONSTRAINT custom_deduction_types_payroll_rule_code_format
  CHECK (
    payroll_rule_code IS NULL
    OR (
      payroll_rule_code ~ '^[a-z][a-z0-9_]*$'
      AND payroll_rule_code NOT LIKE 'custom\_%'
    )
  );

-- Slice 3: register the Kenya voluntary NSSF employee-side token in the pack token
-- registry. This mirrors the Ghana Tier-3 precedent (ADR 0010 Amendment 2). It
-- documents the token; the resolver already handles `sum_rule.<code>.<side>` in
-- return templates directly, so no resolver change is required.
INSERT INTO public.pack_token_registry (
  pack_id, token_path, source, data_type, description
)
SELECT
  p.id,
  'employee.nssf_voluntary_amount',
  'employee_custom_deduction',
  'numeric',
  'Monthly NSSF voluntary top-up (Type-105) amount for the employee, sourced from an active employee_custom_deductions row linked to a custom_deduction_types row where payroll_rule_code = ''nssf_voluntary''.'
FROM public.localization_packs p
WHERE p.country_code = 'KE'
  AND NOT EXISTS (
    SELECT 1 FROM public.pack_token_registry r
    WHERE r.pack_id = p.id AND r.token_path = 'employee.nssf_voluntary_amount'
  );

-- Slice 4: advisory pack row so publishers can document the recommended tenant
-- setup (rule_type='custom_deduction_advisory'; parameters carry the target
-- payroll_rule_code + payslip group + GL role). Purely documentation — the
-- actual per-tenant custom_deduction_types row is created by HR from the
-- existing Employee Deductions UI when the employee submits the NSSF check-off
-- form. No compute-payroll code reads this row.
INSERT INTO public.localization_pack_payroll_templates (
  pack_id, rule_type, rule_name, description, parameters, sort_order, computation_method
)
SELECT
  p.id,
  'custom_deduction_advisory',
  'NSSF Voluntary Top-Up (Type-105)',
  'Advisory template. Kenya tenants materialise this as a public.custom_deduction_types row (code="nssf_voluntary", payroll_rule_code="nssf_voluntary", tax_treatment="post_tax", is_employer_contribution=false, computation_method="flat_amount", payslip_group="voluntary_deduction", gl_liability_account_id = tier3_payable) when an employee submits an NSSF Voluntary Member Contributions Monthly Check-Off form. Amount and effective dates are captured on the resulting employee_custom_deductions row and appear on the NSSF Monthly Byproduct Return VOLUNTARY column.',
  jsonb_build_object(
    'payroll_rule_code', 'nssf_voluntary',
    'tax_treatment', 'post_tax',
    'is_employer_contribution', false,
    'computation_method', 'flat_amount',
    'payslip_group', 'voluntary_deduction',
    'gl_default_account_setting_key', 'tier3_payable',
    'return_template_binding', jsonb_build_object(
      'template_code', 'NSSF_RET',
      'column_key', 'voluntary',
      'source', 'sum_rule.nssf_voluntary.employee'
    ),
    'legal_reference', 'NSSF Act No. 45 of 2013',
    'regulation_citation', 'NSSF Voluntary Member Contributions Monthly Check-Off System — Contribution Type 105.'
  ),
  810,
  'flat_amount'
FROM public.localization_packs p
WHERE p.country_code = 'KE'
  AND NOT EXISTS (
    SELECT 1
    FROM public.localization_pack_payroll_templates t
    WHERE t.pack_id = p.id
      AND t.rule_type = 'custom_deduction_advisory'
      AND t.rule_name = 'NSSF Voluntary Top-Up (Type-105)'
  );