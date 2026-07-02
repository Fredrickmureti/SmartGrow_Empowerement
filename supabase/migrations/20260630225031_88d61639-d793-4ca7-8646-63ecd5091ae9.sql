
DO $kepack$
DECLARE
  v_pack_id uuid := 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  v_helb_id uuid;
BEGIN
  -- 1. Statutory authorities
  UPDATE public.statutory_authorities SET portal_url='https://itax.kra.go.ke',          efiling_endpoint='https://itax.kra.go.ke/KRA-Portal',         updated_at=now() WHERE pack_id=v_pack_id AND code='KENYA_REVENUE_AUTHORITY';
  UPDATE public.statutory_authorities SET portal_url='https://eservice.nssfkenya.co.ke',efiling_endpoint='https://eservice.nssfkenya.co.ke/byproduct', updated_at=now() WHERE pack_id=v_pack_id AND code='NATIONAL_SOCIAL_SECURITY_FUND';
  UPDATE public.statutory_authorities SET portal_url='https://sha.go.ke',               efiling_endpoint='https://sha.go.ke/employer-portal',         updated_at=now() WHERE pack_id=v_pack_id AND code='SOCIAL_HEALTH_AUTHORITY';
  UPDATE public.statutory_authorities SET portal_url='https://nitaportal.nita.go.ke',   efiling_endpoint='https://nitaportal.nita.go.ke/levy',        updated_at=now() WHERE pack_id=v_pack_id AND code='NATIONAL_INDUSTRIAL_TRAINING_AUTHORITY';

  INSERT INTO public.statutory_authorities (pack_id, country_code, code, display_name, portal_url, efiling_endpoint)
  VALUES (v_pack_id, 'KE', 'HIGHER_EDUCATION_LOANS_BOARD', 'Higher Education Loans Board', 'https://www.helb.co.ke', 'https://employerportal.helb.co.ke')
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_helb_id FROM public.statutory_authorities WHERE pack_id=v_pack_id AND code='HIGHER_EDUCATION_LOANS_BOARD';

  -- 2. Backfill return template submission metadata
  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','KRA P10 v2024'),
    legal_reference='Income Tax Act (Cap 470) §37; Tax Procedures Act 2015 §17',
    regulation_citation='KRA iTax PAYE Return — P10 Monthly',
    effective_date=COALESCE(effective_date, DATE '2024-01-01'),
    acknowledgement_spec=jsonb_build_object('kind','itax_receipt','retain_days',2555),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='P10';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_download',
    submission_format=jsonb_build_object('kind','pdf','schema_ref','KRA P10A Register'),
    legal_reference='Income Tax Act (Cap 470) §37',
    regulation_citation='KRA PAYE Detail Register — P10A',
    effective_date=COALESCE(effective_date, DATE '2024-01-01'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='P10A';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','KRA P10D Annual'),
    legal_reference='Income Tax Act (Cap 470) §37; Tax Procedures Act 2015 §17',
    regulation_citation='KRA Annual PAYE Reconciliation — P10D',
    effective_date=COALESCE(effective_date, DATE '2024-01-01'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='P10D';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','KRA AHL Byproduct'),
    legal_reference='Affordable Housing Act 2024 §4; Finance Act 2023',
    regulation_citation='KRA Affordable Housing Levy — Monthly Byproduct',
    effective_date=COALESCE(effective_date, DATE '2024-03-19'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='AHL_RET';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','NSSF H5 Byproduct'),
    legal_reference='NSSF Act 2013 §20; NSSF Act (Commencement) Order',
    regulation_citation='NSSF Monthly Byproduct — H5 schedule',
    effective_date=COALESCE(effective_date, DATE '2024-02-01'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='NSSF_RET';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','SHA Employer Byproduct'),
    legal_reference='Social Health Insurance Act 2023 §27; SHIF Regulations 2024',
    regulation_citation='SHA Monthly Employer Contribution — Byproduct',
    effective_date=COALESCE(effective_date, DATE '2024-10-01'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='SHIF_RET';

  UPDATE public.localization_pack_return_templates SET
    submission_channel='portal_upload',
    submission_format=jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','NITA Annual Levy'),
    legal_reference='Industrial Training Act (Cap 237) §5B',
    regulation_citation='NITA Annual Industrial Training Levy Return',
    effective_date=COALESCE(effective_date, DATE '2024-01-01'),
    updated_at=now()
  WHERE pack_id=v_pack_id AND code='NITA_RET';

  -- 3. New HELB return template
  INSERT INTO public.localization_pack_return_templates (
    pack_id, code, display_name, description, authority_name, authority_id,
    period, output, body, due_day, due_month_offset, sort_order,
    submission_format, submission_channel, legal_reference, regulation_citation,
    effective_date, approval_required, acknowledgement_spec
  ) VALUES (
    v_pack_id, 'HELB_LR', 'HELB Monthly Loan Repayment Schedule',
    'Employer check-off schedule of HELB loan deductions remitted to the Higher Education Loans Board.',
    'Higher Education Loans Board', v_helb_id,
    'monthly', 'csv',
    jsonb_build_object('columns', jsonb_build_array(
      jsonb_build_object('header','HELB_NUMBER','token','{employee.statutory_identifiers.helb_number}'),
      jsonb_build_object('header','NATIONAL_ID','token','{employee.national_id}'),
      jsonb_build_object('header','EMPLOYEE_NAME','token','{employee.full_name}'),
      jsonb_build_object('header','AMOUNT','token','{rule_output.helb.deduction_amount}'),
      jsonb_build_object('header','PERIOD','token','{run.period_label}')
    )),
    15, 1, 50,
    jsonb_build_object('kind','csv','delimiter',',','header',true,'encoding','UTF-8','schema_ref','HELB Employer Portal CSV v3'),
    'portal_upload',
    'Higher Education Loans Board Act 1995 §15; Universities (Amendment) Act 2016',
    'HELB Employer Loan Recovery Schedule',
    DATE '2024-01-01', false,
    jsonb_build_object('kind','helb_receipt','retain_days',2555)
  ) ON CONFLICT DO NOTHING;

  -- 4. Garnishment kinds
  INSERT INTO public.localization_pack_garnishment_kinds
    (pack_id, code, label, default_priority, always_first, counts_toward_aggregate_cap, max_concurrent, employer_fee_amount, required_identifiers, evidence_required, description)
  VALUES
    (v_pack_id,'child_maintenance','Child Maintenance Order',10,true,false,NULL,0,
      '["court_order_number","beneficiary_name"]'::jsonb,true,
      'Maintenance order issued under the Children Act 2022 — paid before any aggregate-cap garnishment.'),
    (v_pack_id,'kra_agency_notice','KRA Agency Notice (Tax Recovery)',20,true,false,NULL,0,
      '["agency_notice_ref","tax_period"]'::jsonb,true,
      'Agency Notice issued under Tax Procedures Act 2015 §42 — recovery of tax debts; precedence over civil orders.'),
    (v_pack_id,'court_attachment','Court Attachment of Earnings',50,false,true,3,0,
      '["court_order_number","case_number"]'::jsonb,true,
      'Civil court attachment of earnings — counts toward Employment Act 2007 §19(3) two-thirds cap.'),
    (v_pack_id,'helb_recovery','HELB Loan Recovery',40,false,true,1,0,
      '["helb_number"]'::jsonb,true,
      'Higher Education Loans Board employer check-off — statutory under HELB Act 1995 §15.'),
    (v_pack_id,'sacco_checkoff','SACCO Check-off',60,false,true,NULL,0,
      '["sacco_name","member_number","authorization_ref"]'::jsonb,true,
      'Voluntary SACCO deduction authorized in writing by the employee under Co-operative Societies Act §35A.'),
    (v_pack_id,'employer_advance','Employer Salary Advance Recovery',70,false,true,NULL,0,
      '["advance_reference"]'::jsonb,false,
      'Recovery of employer-issued salary advance — subject to the two-thirds aggregate cap.')
  ON CONFLICT (pack_id, code) DO NOTHING;

  -- 5. Garnishment policy
  INSERT INTO public.localization_pack_garnishment_policies
    (pack_id, policy_key, aggregate_cap_pct, min_take_home_amount, min_take_home_pct,
     disposable_income_excludes, priority_resolution, protected_earnings_formula_token, notes)
  VALUES
    (v_pack_id,'default',66.6667,NULL,33.3333,
     '["paye","shif","nssf","housing_levy","nita"]'::jsonb,
     'always_first_then_priority_then_date',
     '{rule_output.gross_pay} - {rule_output.paye} - {rule_output.shif} - {rule_output.nssf} - {rule_output.housing_levy}',
     'Employment Act 2007 §19(3): aggregate of deductions (excluding statutory contributions) must not exceed two-thirds of basic wages. Child Maintenance Orders and KRA Agency Notices take precedence and are cap-exempt.')
  ON CONFLICT (pack_id, policy_key) DO NOTHING;
END
$kepack$;
