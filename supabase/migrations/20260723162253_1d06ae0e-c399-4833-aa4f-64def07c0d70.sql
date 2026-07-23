-- Fix: payroll_create_and_map_account references non-existent enum
-- public.account_type_enum. The real enum is public.account_type.
-- Redefines the function preserving the (uuid,uuid,text,text,text,text,uuid,text) signature.

CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL, _branch_id uuid DEFAULT NULL,
  _source text DEFAULT 'tenant_override'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
  VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type, true, false)
  RETURNING id INTO v_account_id;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(
    _org_id, _business_id, _branch_id, _setting_key, v_account_id,
    _source, NULL, NULL, v_user, NULL
  );
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(
  uuid, uuid, text, text, text, text, uuid, text
) TO authenticated, service_role;
