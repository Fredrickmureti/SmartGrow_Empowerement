DO $$
DECLARE
  v_org uuid := 'ad0f633a-d24c-4602-82f3-cf98ced2c246';
  v_biz uuid := '7a176122-bb9f-4719-a33a-512fb4eaed8f';
  v_salary_id uuid;
  v_netpay_id uuid;
BEGIN
  PERFORM set_config('app.bypass_org_lock', 'on', true);

  SELECT id INTO v_salary_id FROM public.accounts
   WHERE business_id = v_biz AND code = '6110' AND COALESCE(is_header,false)=false LIMIT 1;
  IF v_salary_id IS NULL THEN
    INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
    VALUES (v_org, v_biz, 'expense', '6110', 'Staff Salaries', 'payroll_expense', false, true, 'Auto-provisioned by payroll hardening Phase 2 follow-up')
    RETURNING id INTO v_salary_id;
  END IF;

  SELECT id INTO v_netpay_id FROM public.accounts
   WHERE business_id = v_biz AND code = '2190' LIMIT 1;
  IF v_netpay_id IS NULL THEN
    INSERT INTO public.accounts (organization_id, business_id, account_type, code, name, detail_type, is_header, is_system, description)
    VALUES (v_org, v_biz, 'liability', '2190', 'Net Salary Payable', 'payroll_clearing', false, true, 'Auto-provisioned by payroll hardening Phase 2 follow-up')
    RETURNING id INTO v_netpay_id;
  END IF;

  UPDATE public.default_account_settings SET account_id = v_salary_id
   WHERE organization_id = v_org AND business_id = v_biz AND setting_key = 'salary_expense';

  UPDATE public.default_account_settings SET account_id = v_netpay_id
   WHERE organization_id = v_org AND business_id = v_biz AND setting_key = 'net_salary_payable';

  PERFORM set_config('app.bypass_org_lock', 'off', true);
END$$;