DO $$
DECLARE
  _ke_pack uuid;
  _v10 uuid;
  _monthly_cols jsonb;
  _derived jsonb;
  _p9_blocks jsonb;
BEGIN
  SELECT id INTO _ke_pack
  FROM public.localization_packs
  WHERE country_code = 'KE'
  ORDER BY created_at
  LIMIT 1;

  IF _ke_pack IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO _v10
  FROM public.pack_versions
  WHERE pack_id = _ke_pack
    AND version = '10.0.0'
    AND status = 'published'
  ORDER BY published_at DESC NULLS LAST, created_at DESC
  LIMIT 1;

  UPDATE public.localization_packs
     SET version = '10.0.0',
         updated_at = now()
   WHERE id = _ke_pack;

  _monthly_cols := jsonb_build_array(
    jsonb_build_object('key','month_index','header','Month','width',30,'align','left','format','text'),
    jsonb_build_object('key','basic_salary','source_key','basic','header','A · Basic Salary','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','non_cash_benefits','source_key','non_cash_benefits','header','B · Non-Cash Benefits','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','housing_benefit','source_key','housing_benefit','header','C · Quarters','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','gross_pay','header','D · Gross Pay','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_30pct_of_basic','header','E1 · 30% of A','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_contribution_actual','source_key','nssf','header','E2 · Pension/NSSF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','pension_statutory_cap','header','E3 · Deductible Cap','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','ahl_employee','source_key','housing_levy','header','F · AHL','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','shif_employee','source_key','shif','header','G · SHIF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','prmf_employee','source_key','prmf','header','H · PRMF','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','mortgage_interest_relief_base','source_key','mortgage_interest_relief_base','header','I · Mortgage Interest','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','total_relief_deductions','header','J · Total Deductions','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','chargeable_pay','header','K · Chargeable Pay','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_gross','header','L · Tax Charged','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','personal_relief','source_key','personal_relief','header','M · Personal Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','insurance_relief','source_key','insurance_relief','header','N · Insurance Relief','width','1fr','align','right','format','currency'),
    jsonb_build_object('key','paye_net','source_key','paye','header','O · PAYE Tax','width','1fr','align','right','format','currency')
  );

  _derived := jsonb_build_array(
    jsonb_build_object('key','gross_pay','expr','sum','args', jsonb_build_array('basic_salary','housing_allowance','transport_allowance','non_cash_benefits','housing_benefit')),
    jsonb_build_object('key','pension_30pct_of_basic','expr','pct','args', jsonb_build_array('basic_salary', 0.30)),
    jsonb_build_object('key','pension_statutory_cap','expr','min','args', jsonb_build_array('pension_30pct_of_basic','pension_contribution_actual', 30000)),
    jsonb_build_object('key','total_relief_deductions','expr','sum','args', jsonb_build_array('pension_statutory_cap','ahl_employee','shif_employee','prmf_employee','mortgage_interest_relief_base')),
    jsonb_build_object('key','chargeable_pay','expr','sub','args', jsonb_build_array('gross_pay','total_relief_deductions')),
    jsonb_build_object('key','paye_gross','expr','sum','args', jsonb_build_array('paye_net','personal_relief','insurance_relief'))
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
      'rule_codes', jsonb_build_array('basic','housing_allowance','transport_allowance','non_cash_benefits','housing_benefit','nssf','housing_levy','shif','prmf','mortgage_interest_relief_base','paye','personal_relief','insurance_relief'),
      'footer', jsonb_build_object('label','YTD Total','aggregate','sum'),
      'options', jsonb_build_object('striped', true, 'wrap', true, 'repeat_header', true, 'padding', 2, 'line_height', 1.15, 'header_bg', true)
    ),
    jsonb_build_object(
      'type','notes','title','IMPORTANT',
      'paragraphs', jsonb_build_array(
        'Issued under the Income Tax Act CAP 470, Section 37 (Kenya Revenue Authority).',
        'Column D is derived from taxable cash earnings available in payroll for the month. Column O uses the net PAYE rule code produced by payroll. Where relief rule codes exist separately, Column L is reconstructed as O + M + N.',
        'Deductible pension contribution is capped at the lower of 30% of basic pay, actual pension/NSSF contribution, and the statutory monthly cap. SHIF and Affordable Housing Levy are included where payroll has posted those rule codes.'
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
              || jsonb_build_object('blocks', _p9_blocks),
         pack_version_id = coalesce(_v10, pack_version_id),
         updated_at = now()
   WHERE pack_id = _ke_pack
     AND code IN ('P9','P9A');
END $$;