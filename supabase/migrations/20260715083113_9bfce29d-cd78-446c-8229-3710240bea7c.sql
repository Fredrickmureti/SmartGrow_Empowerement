
UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
      body,
      '{document,3,derived_columns}',
      '[
        {"key":"gross_pay","expr":"sum","args":["basic_salary","housing_allowance","transport_allowance","non_cash_benefits","housing_benefit"]},
        {"key":"pension_30pct_of_basic","expr":"pct","args":["basic_salary",0.30]},
        {"key":"pension_statutory_cap","expr":"min","args":["pension_30pct_of_basic","pension_contribution_actual",30000]},
        {"key":"total_relief_deductions","expr":"sum","args":["pension_statutory_cap","ahl_employee","shif_employee","prmf_employee","mortgage_interest_relief_base"]},
        {"key":"chargeable_pay","expr":"sub","args":["gross_pay","total_relief_deductions"]},
        {"key":"paye_gross","expr":"sum","args":["paye_net","personal_relief","insurance_relief"]}
      ]'::jsonb
    ),
    updated_at = now()
WHERE id = '8426e8da-f9c9-48cc-9d60-2dad85566e5c';

UPDATE public.localization_packs
SET version = '10.1.4', updated_at = now()
WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

INSERT INTO public.pack_versions (
  pack_id, version, status, changelog, snapshot,
  published_at, parent_version_id, schema_version
)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  '10.1.4',
  'published',
  jsonb_build_object(
    'summary', 'P9A derived-column keys corrected',
    'notes', 'Rewrote KE P9A matrix derived_columns to reference the real column keys (gross_pay, pension_30pct_of_basic, pension_statutory_cap, total_relief_deductions, chargeable_pay, paye_gross) instead of the invented col_a..col_o shorthand. Restores rendering of Cols D, E1, E3, J, K, L from canonical payslip_lines. No engine, resolver, or matrix-engine change.'
  ),
  jsonb_build_object(
    'templates_updated', jsonb_build_array('P9A')
  ),
  now(),
  '4c6c48e2-8718-46ea-ae56-7e03117ada08',
  3
);
