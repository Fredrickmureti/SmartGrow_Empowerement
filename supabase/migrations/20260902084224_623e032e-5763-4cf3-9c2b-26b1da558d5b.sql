DO $$
DECLARE
  v_biz uuid;
  v_org uuid;
  v_assets uuid;
  v_income uuid;
  v_liab uuid;
  v_exp uuid;
BEGIN
  SELECT id, organization_id INTO v_biz, v_org FROM public.businesses ORDER BY created_at LIMIT 1;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'No institution configured'; END IF;

  SELECT id INTO v_assets FROM public.accounts WHERE business_id=v_biz AND code='1100';
  SELECT id INTO v_income FROM public.accounts WHERE business_id=v_biz AND code='4200';
  SELECT id INTO v_liab   FROM public.accounts WHERE business_id=v_biz AND account_type='liability' AND is_header IS TRUE ORDER BY code LIMIT 1;
  SELECT id INTO v_exp    FROM public.accounts WHERE business_id=v_biz AND code='6000';

  INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, description, parent_id, is_active, is_header)
  SELECT v_org, v_biz, x.atype::public.account_type, x.code, x.name, x.descr, x.parent, true, false
  FROM (VALUES
    ('1370','Loan Principal Receivable','Outstanding client loan principal','asset',v_assets),
    ('1375','Loan Interest Receivable','Accrued unpaid client loan interest','asset',v_assets),
    ('4320','Loan Fee Income','Processing and other loan fees','income',v_income),
    ('4330','Loan Penalty Income','Late payment penalties on client loans','income',v_income),
    ('2410','Client Loan Advances','Client funds received beyond amounts due','liability',v_liab),
    ('2420','Loan Loss Provision','Provision against expected loan losses','liability',v_liab),
    ('2430','Suspended Loan Interest','Interest suspended on non-performing loans','liability',v_liab)
  ) AS x(code,name,descr,atype,parent)
  WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.business_id=v_biz AND a.code=x.code);

  INSERT INTO public.mf_account_mappings (business_id, branch_id, mapping_key, account_id)
  SELECT v_biz, NULL, m.key, a.id
  FROM (VALUES
    ('principal_receivable','1370'),
    ('interest_receivable','1375'),
    ('interest_income','4310'),
    ('fee_income','4320'),
    ('penalty_income','4330'),
    ('cash','1111'),
    ('bank','1112'),
    ('mobile_money','1030'),
    ('write_off_expense','6420'),
    ('loan_loss_provision','2420'),
    ('suspended_interest','2430'),
    ('client_advance','2410')
  ) AS m(key,code)
  JOIN public.accounts a ON a.business_id=v_biz AND a.code=m.code
  WHERE NOT EXISTS (
    SELECT 1 FROM public.mf_account_mappings x
    WHERE x.business_id=v_biz AND x.branch_id IS NULL AND x.mapping_key=m.key
  );
END $$;