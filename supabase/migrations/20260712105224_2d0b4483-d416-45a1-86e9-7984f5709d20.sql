
-- ADR-0060 addendum: Kenya P9 / P9A v10.0.0
-- - landscape A4 (17-column KRA grid needs it)
-- - data_source = 'monthly_matrix' (pivoted 12-row matrix, not rule-code stream)
-- - derived_columns declared inline: E1, J, K, O are pack-authored formulas
DO $$
DECLARE
  _ke_pack uuid;
  _p9_blocks jsonb;
  _monthly_cols jsonb;
  _derived jsonb;
BEGIN
  SELECT id INTO _ke_pack FROM public.localization_packs WHERE country_code='KE' LIMIT 1;
  IF _ke_pack IS NULL THEN RETURN; END IF;

  _monthly_cols := jsonb_build_array(
    jsonb_build_object('key','month_index','header','Month','width',30,'align','left','format','text'),
    jsonb_build_object('key','basic_salary','header','A · Basic Salary','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','non_cash_benefits','header','B · Non-Cash','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','housing_benefit','header','C · Quarters','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','gross_pay','header','D · Gross Pay','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_30pct_of_basic','header','E1 · 30% of A','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_contribution_actual','header','E2 · Actual Pension','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_statutory_cap','header','E3 · Cap','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','ahl_employee','header','F · AHL','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','shif_employee','header','G · SHIF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','prmf_employee','header','H · PRMF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','mortgage_interest_relief_base','header','I · Mortgage Int.','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','total_relief_deductions','header','J · Total Deductions','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','chargeable_pay','header','K · Chargeable Pay','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_gross','header','L · Tax Charged','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','personal_relief','header','M · Personal Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','insurance_relief','header','N · Insurance Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_net','header','O · PAYE (L−M−N)','width','1fr','align','right','format','currency')
  );

  -- Order matters: later expressions may reference earlier derived keys.
  _derived := jsonb_build_array(
    jsonb_build_object('key','pension_30pct_of_basic','expr','pct',
      'args', jsonb_build_array('basic_salary', 0.30)),
    jsonb_build_object('key','pension_statutory_cap','expr','min',
      'args', jsonb_build_array('pension_30pct_of_basic','pension_contribution_actual', 30000)),
    jsonb_build_object('key','total_relief_deductions','expr','sum',
      'args', jsonb_build_array('pension_statutory_cap','ahl_employee','shif_employee','prmf_employee','mortgage_interest_relief_base')),
    jsonb_build_object('key','chargeable_pay','expr','sub',
      'args', jsonb_build_array('gross_pay','total_relief_deductions')),
    jsonb_build_object('key','paye_net','expr','sub',
      'args', jsonb_build_array('paye_gross','personal_relief','insurance_relief'))
  );

  _p9_blocks := jsonb_build_array(
    jsonb_build_object(
      'type','field_grid','title','Employer','columns',2,'data_source','employer',
      'fields', jsonb_build_array(
        jsonb_build_object('key','name','label','Employer Name','emphasis','primary'),
        jsonb_build_object('key','tax_pin','label','Employer KRA PIN'),
        jsonb_build_object('key','address','label','Address'),
        jsonb_build_object('key','tax_office','label','Tax Office')
      )
    ),
    jsonb_build_object(
      'type','field_grid','title','Employee','columns',2,'data_source','employee',
      'fields', jsonb_build_array(
        jsonb_build_object('key','full_name','label','Employee Name','emphasis','primary'),
        jsonb_build_object('key','employee_number','label','Employee Number'),
        jsonb_build_object('key','tax_pin','label','Employee KRA PIN'),
        jsonb_build_object('key','national_id','label','National ID'),
        jsonb_build_object('key','position','label','Position'),
        jsonb_build_object('key','department','label','Department')
      )
    ),
    jsonb_build_object(
      'type','table',
      'title','Monthly PAYE Computation (KRA Columns A–O)',
      'data_source','monthly_matrix',
      'group_by','month_index',
      'amount_field','employee_amount',
      'columns', _monthly_cols,
      'derived_columns', _derived,
      'footer', jsonb_build_object('label','YTD Total','aggregate','sum'),
      'options', jsonb_build_object(
        'striped', true, 'wrap', true, 'repeat_header', true,
        'padding', 2, 'line_height', 1.15, 'header_bg', true
      )
    ),
    jsonb_build_object(
      'type','notes','title','IMPORTANT',
      'paragraphs', jsonb_build_array(
        'Issued under the Income Tax Act CAP 470, Section 37 (Kenya Revenue Authority).',
        'Personal Relief: KES 2,400/month (KES 28,800/year). Insurance Relief: 15% of premium, capped at KES 5,000/month (KES 60,000/year).',
        'Deductible pension contribution: up to KES 20,000/month (pre-Dec 2024) or KES 30,000/month (from Dec 2024). Deductible owner-occupied mortgage interest: up to KES 25,000/month (pre-Dec 2024) or KES 30,000/month (from Dec 2024). Deductible PRMF contribution: up to KES 15,000/month (from Dec 2024).',
        'SHIF and Affordable Housing Levy (AHL) deductions are effective from December 2024.'
      )
    ),
    jsonb_build_object(
      'type','signature_block','title','Signatures',
      'slots', jsonb_build_array(
        jsonb_build_object('caption','Preparer','sub_caption','Name & Signature'),
        jsonb_build_object('caption','Date'),
        jsonb_build_object('caption','Employer Stamp')
      )
    )
  );

  UPDATE public.localization_pack_certificate_templates
     SET body = coalesce(body, '{}'::jsonb)
              || jsonb_build_object('schema_version', 2)
              || jsonb_build_object('page', jsonb_build_object('size','a4','orientation','landscape'))
              || jsonb_build_object('blocks', _p9_blocks)
   WHERE pack_id = _ke_pack AND code IN ('P9','P9A');
END $$;

-- Publish Kenya localization pack v10.0.0. propose-localization-upgrades
-- picks this up on its next fan-out (no direct tenant writes).
INSERT INTO public.pack_versions (pack_id, version, status, changelog, published_at)
SELECT
  id,
  '10.0.0',
  'published',
  jsonb_build_object(
    'adr','0060-addendum-monthly-matrix',
    'summary','Kenya P9 / P9A rewritten with landscape A4, monthly_matrix data source, and pack-authored derived columns (E1/E3/J/K/O). Restores KRA A–O layout without any platform code changes.',
    'templates', jsonb_build_array('P9','P9A'),
    'renderer','v2',
    'orientation','landscape',
    'data_source','monthly_matrix'
  ),
  now()
FROM public.localization_packs
WHERE country_code='KE'
ON CONFLICT DO NOTHING;
