
CREATE OR REPLACE FUNCTION public._payroll_assert_mapping_role(
  _setting_key text,
  _account_id  uuid
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_acct public.accounts%ROWTYPE;
BEGIN
  IF _setting_key IS NULL OR _account_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_acct FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: account % not found', _account_id
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_acct.is_header, false) THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a header / parent account (%)',
      _setting_key, v_acct.code USING ERRCODE = '22023';
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND public._payroll_is_cogs_account(_account_id) THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a Cost of Goods Sold / Cost of Sales account (%)',
      _setting_key, v_acct.code USING ERRCODE = '22023';
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND v_acct.account_type::text <> 'expense' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires an expense-class account, got % (%)',
      _setting_key, v_acct.account_type, v_acct.code USING ERRCODE = '22023';
  END IF;

  IF (_setting_key LIKE '%\_payable' ESCAPE '\')
     AND v_acct.account_type::text <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires a liability-class account, got % (%)',
      _setting_key, v_acct.account_type, v_acct.code USING ERRCODE = '22023';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.payroll_apply_proposed_mappings(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id uuid, _business_id uuid, _accept jsonb, _branch_id uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_count integer := 0; item jsonb; v_key text; v_acct_id uuid;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(_accept, '[]'::jsonb)) LOOP
    v_key := item->>'setting_key';
    v_acct_id := (item->>'account_id')::uuid;
    IF v_key IS NULL OR v_acct_id IS NULL THEN
      RAISE EXCEPTION 'setting_key and account_id are required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = v_acct_id AND a.organization_id = _org_id
        AND (a.business_id IS NULL OR a.business_id = _business_id)
    ) THEN
      RAISE EXCEPTION 'Account % does not belong to this organization/business', v_acct_id
        USING ERRCODE = '42501';
    END IF;
    PERFORM public._payroll_assert_mapping_role(v_key, v_acct_id);
    PERFORM public._upsert_default_account_setting(_org_id, _business_id, _branch_id, v_key, v_acct_id);
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.payroll_create_and_map_account(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.payroll_create_and_map_account(uuid, uuid, text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL, _branch_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid; v_code text; v_prefix text;
  v_lname text := lower(coalesce(_name, ''));
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND lower(_account_type) <> 'expense' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=expense', _setting_key USING ERRCODE = '22023';
  END IF;
  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND (v_lname ~ '(cost of goods sold|cost of sales|cost of revenue|cogs)') THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot create a COGS-flavoured account (%)', _setting_key, _name USING ERRCODE = '22023';
  END IF;
  IF (_setting_key LIKE '%\_payable' ESCAPE '\')
     AND lower(_account_type) <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=liability', _setting_key USING ERRCODE = '22023';
  END IF;

  v_prefix := CASE lower(_account_type)
    WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
    WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
    WHEN 'equity' THEN '3900' ELSE '9000'
  END;
  v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));
  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE organization_id = _org_id
      AND (business_id IS NULL OR business_id = _business_id) AND code = v_code
  ) THEN
    v_code := v_code || '-' || substring(gen_random_uuid()::text, 1, 4);
  END IF;

  INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, is_active, is_header)
  VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false)
  RETURNING id INTO v_account_id;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(_org_id, _business_id, _branch_id, _setting_key, v_account_id);
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(uuid, uuid, text, text, text, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.payroll_validate_post_mappings(p_run_id uuid)
RETURNS TABLE(setting_key text, account_id uuid, account_code text, account_name text,
              violation_code text, severity text, finding_detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_run public.payroll_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT f.setting_key, f.account_id, f.account_code, f.account_name,
         f.violation_code, f.severity, f.finding_detail
  FROM public.payroll_mapping_findings f
  WHERE f.organization_id = v_run.organization_id
    AND (v_run.business_id IS NULL OR f.business_id IS NULL OR f.business_id = v_run.business_id)
    AND f.severity = 'critical';
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_validate_post_mappings(uuid) TO authenticated, service_role;

-- Country-neutral account names ONLY (statutory-specific names live in localisation packs).
INSERT INTO public.default_chart_of_accounts (country_code, account_code, account_name, account_type, parent_code, description, is_system, is_country_neutral)
SELECT c.country_code, v.code, v.name, v.atype::public.account_type, v.parent, v.descr, true, true
FROM (SELECT DISTINCT country_code FROM public.default_chart_of_accounts) c
CROSS JOIN (VALUES
  ('6150', 'Payroll: Employer Contributions',  'expense',   '6000', 'Employer-borne statutory and benefit contributions (employer share of social security, pension match, training levy, housing levy, etc.). Distinct from 6100 Salaries & Wages so gross compensation and employer overhead are reported separately.'),
  ('6160', 'Payroll: Other Costs',             'expense',   '6000', 'Other payroll-related operating expenses (recruitment, training, payroll service fees, severance).'),
  ('2140', 'Payroll Statutory Payable',        'liability', '2100', 'Generic catch-all liability for statutory payroll obligations without a dedicated per-rule account. Preferred over 2110 Accounts Payable so payroll obligations do not pollute AP aging.'),
  ('2150', 'Income Tax Withheld Payable',      'liability', '2100', 'Employee income tax withheld from payroll and owed to the tax authority.'),
  ('2160', 'Pension Contributions Payable',    'liability', '2100', 'Combined employee + employer pension contributions owed to the scheme administrator.'),
  ('2170', 'Net Salary Payable',               'liability', '2100', 'Net pay owed to employees between payroll post and payment. Cleared by post-payroll-payment-gl.')
) v(code, name, atype, parent, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM public.default_chart_of_accounts d
  WHERE d.country_code = c.country_code AND d.account_code = v.code
);

COMMENT ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb, uuid) IS
  'Single canonical writer for payroll GL mappings. Enforces (1) org/business tenancy, (2) role rules via _payroll_assert_mapping_role (no COGS for salary/employer-expense, no header accounts, account_type must match key). Previous dual-overload design was the root cause of the salary->COGS bypass.';

COMMENT ON FUNCTION public.payroll_validate_post_mappings(uuid) IS
  'Defense-in-depth: post-payroll-gl calls this before writing JE lines so a misconfigured mapping is blocked at post time, not just at setup time. Returns only critical findings.';
