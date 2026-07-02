-- Phase B — Backfill Kenya-pack-scoped tokens into the token registry so the
-- return-template editor's column-source picker can read them dynamically
-- instead of hardcoding KE identifiers in KNOWN_SOURCES.

DO $$
DECLARE
  _ke_pack_id uuid;
BEGIN
  SELECT id INTO _ke_pack_id
    FROM public.localization_packs
    WHERE country_code = 'KE'
    ORDER BY (CASE WHEN is_published THEN 0 ELSE 1 END), version DESC
    LIMIT 1;

  IF _ke_pack_id IS NULL THEN
    RAISE NOTICE 'Phase B backfill: no Kenya pack found, skipping token seed';
    RETURN;
  END IF;

  INSERT INTO public.pack_token_registry
    (pack_id, token_path, source, data_type, sample_value, description)
  VALUES
    (_ke_pack_id, 'employee.tax_pin',     'employee', 'string', '"A001234567X"'::jsonb, 'KRA PIN (Kenya)'),
    (_ke_pack_id, 'employee.nssf_number', 'employee', 'string', '"1234567890"'::jsonb,  'NSSF membership number (Kenya)'),
    (_ke_pack_id, 'employee.nhif_number', 'employee', 'string', '"12345678"'::jsonb,    'NHIF number (legacy, Kenya)'),
    (_ke_pack_id, 'employee.shif_number', 'employee', 'string', '"SHA12345678"'::jsonb, 'SHIF number (Kenya)'),
    (_ke_pack_id, 'employee.branch_id',   'employee', 'string', '"BR-01"'::jsonb,       'Branch identifier')
  ON CONFLICT (pack_id, token_path) DO NOTHING;
END $$;

-- Also seed platform-reserved synthetic aggregates that the return template
-- editor needs but the engine computes at run time (not per-row tokens).
-- These are pack-agnostic (pack_id = NULL).
INSERT INTO public.pack_token_registry
  (pack_id, token_path, source, data_type, sample_value, description)
VALUES
  (NULL, 'sum_employee_amount', 'system', 'currency', '0'::jsonb,
    'Reserved aggregate: SUM(payslip_lines.amount) over employee deductions for the rule_codes filter.'),
  (NULL, 'sum_employer_amount', 'system', 'currency', '0'::jsonb,
    'Reserved aggregate: SUM(payslip_lines.amount) over employer contributions for the rule_codes filter.'),
  (NULL, 'sum_taxable_amount',  'system', 'currency', '0'::jsonb,
    'Reserved aggregate: SUM(payslip_lines.taxable_base) over the rule_codes filter.')
ON CONFLICT (pack_id, token_path) DO NOTHING;