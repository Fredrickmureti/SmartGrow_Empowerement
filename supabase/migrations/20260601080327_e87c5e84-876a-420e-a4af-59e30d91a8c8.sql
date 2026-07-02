CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(_org_id uuid, _business_id uuid, _setting_key text, _name text, _account_type text, _code text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid; v_existing_mapped_id uuid; v_existing_code_id uuid;
  v_code text; v_prefix text; v_lname text := lower(coalesce(_name, ''));
  v_is_role boolean := false; v_detail_type text; v_lock_key bigint;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true)
    THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND lower(_account_type) <> 'expense' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=expense', _setting_key USING ERRCODE = '22023';
  END IF;
  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND (v_lname ~ '(cost of goods sold|cost of sales|cost of revenue|cogs)') THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot create a COGS-flavoured account (%)', _setting_key, _name USING ERRCODE = '22023';
  END IF;
  IF (_setting_key LIKE '%\_payable' ESCAPE '\' OR _setting_key = 'net_salary_payable')
     AND lower(_account_type) <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=liability', _setting_key USING ERRCODE = '22023';
  END IF;

  v_lock_key := hashtextextended(_business_id::text || '|' || _setting_key, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = _setting_key) INTO v_is_role;

  IF v_is_role THEN
    SELECT suggested_code INTO v_code FROM public.system_account_template
     WHERE role_key = _setting_key AND account_type::text = lower(_account_type) LIMIT 1;
  END IF;

  IF v_code IS NULL THEN
    v_prefix := CASE lower(_account_type)
      WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
      WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
      WHEN 'equity' THEN '3900' ELSE '9000' END;
    v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));
  END IF;

  -- Resolve detail_type up front so BOTH branches can persist it.
  -- The accounts-table trigger requires every postable leaf account to have a
  -- detail_type; without this, the non-role branch's raw INSERT used to fail
  -- with "detail_type is required for postable (leaf) accounts".
  v_detail_type := public._resolve_account_detail_type(_setting_key, lower(_account_type), NULL);

  IF v_is_role THEN
    v_account_id := public.upsert_system_account(
      _org_id, _business_id, _setting_key,
      lower(_account_type), v_detail_type,
      v_code, _name, NULL, NULL, false);
  ELSE
    SELECT account_id INTO v_existing_mapped_id
      FROM public.default_account_settings
     WHERE organization_id = _org_id
       AND (business_id IS NULL OR business_id = _business_id)
       AND setting_key = _setting_key LIMIT 1;
    IF v_existing_mapped_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.accounts WHERE id = v_existing_mapped_id AND is_active = true) THEN
      v_account_id := v_existing_mapped_id;
      -- Repair pre-existing rows whose detail_type was never set, so the
      -- downstream role-eligibility guard has something to validate against.
      UPDATE public.accounts
         SET detail_type = v_detail_type
       WHERE id = v_account_id
         AND detail_type IS NULL
         AND v_detail_type IS NOT NULL;
    ELSE
      SELECT id INTO v_existing_code_id
        FROM public.accounts
       WHERE organization_id = _org_id
         AND (business_id IS NULL OR business_id = _business_id)
         AND code = v_code LIMIT 1;
      IF v_existing_code_id IS NOT NULL THEN
        v_account_id := v_existing_code_id;
        UPDATE public.accounts
           SET detail_type = v_detail_type
         WHERE id = v_account_id
           AND detail_type IS NULL
           AND v_detail_type IS NOT NULL;
      ELSE
        INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, detail_type, is_active, is_header)
        VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type, v_detail_type, true, false)
        RETURNING id INTO v_account_id;
      END IF;
    END IF;
  END IF;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(_org_id, _business_id, _branch_id, _setting_key, v_account_id);
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$function$;