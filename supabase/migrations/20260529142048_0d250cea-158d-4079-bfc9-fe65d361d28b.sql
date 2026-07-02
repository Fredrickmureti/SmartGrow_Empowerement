
-- Phase 6 — Closeout (auditor self-exclusion)

CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid,
  _business_id uuid,
  _country_code text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
  _is_header boolean;
  _norm_account_type text;
  _lock_key bigint;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'provision_default_chart_of_accounts: _business_id required';
  END IF;

  _lock_key := ('x' || substr(md5('coa:'||_business_id::text||':'||_resolved_country), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(_lock_key);

  IF NOT EXISTS (SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.default_chart_of_accounts c
       WHERE c.country_code = _resolved_country
         AND c.parent_code = _template.account_code
    ) INTO _is_header;

    _norm_account_type := CASE
      WHEN lower(_template.account_type::text) = 'revenue' THEN 'income'
      ELSE _template.account_type::text
    END;

    _new_id := NULL;

    IF _template.role_key IS NOT NULL THEN
      BEGIN
        _new_id := public.upsert_system_account(
          _org_id, _business_id, _template.role_key,
          _norm_account_type, _template.detail_type,
          _template.account_code, _template.account_name,
          _template.description, _parent_id, _is_header
        );
      EXCEPTION
        WHEN unique_violation THEN
          RAISE NOTICE 'role % already exists for biz %, continuing', _template.role_key, _business_id;
          _new_id := NULL;
      END;
    ELSE
      BEGIN
        INSERT INTO public.accounts (
          organization_id, business_id, code, name, account_type,
          detail_type, parent_id, description, is_system, is_header, is_active
        ) VALUES (
          _org_id, _business_id, _template.account_code, _template.account_name,
          _norm_account_type::public.account_type, _template.detail_type,
          _parent_id, _template.description,
          coalesce(_template.is_system, false), _is_header, true
        )
        ON CONFLICT DO NOTHING
        RETURNING id INTO _new_id;
      EXCEPTION
        WHEN unique_violation THEN
          _new_id := NULL;
      END;

      IF _new_id IS NULL THEN
        SELECT id INTO _new_id FROM public.accounts
         WHERE organization_id = _org_id
           AND business_id = _business_id
           AND code = _template.account_code
         LIMIT 1;
      END IF;
    END IF;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);
  PERFORM public.provision_missing_system_accounts(_org_id, _business_id, false);

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'opening_balance_equity', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'opening_balance_equity' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'opening_balance_equity')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'suspense', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'suspense' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'suspense')
  ON CONFLICT DO NOTHING;

  RETURN _accounts_created;
END;
$function$;


CREATE OR REPLACE FUNCTION public.audit_system_account_writer_allowlist()
RETURNS TABLE(function_name text, signature text, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _allow text[] := ARRAY[
    'upsert_system_account',
    'reset_organization_data',
    '_execute_organization_delete',
    'governance_run_teardown',
    'platform_delete_organization',
    'reset_my_workspace',
    'install_localization_pack_atomic',
    'provision_default_chart_of_accounts',
    'payroll_create_and_map_account'
  ];
  -- Functions whose source legitimately mentions these tokens for meta-purposes
  -- (auditors, enforcement triggers) without ever writing them.
  _meta_exempt text[] := ARRAY[
    'audit_system_account_writer_allowlist',
    'enforce_system_account_helper'
  ];
  _rec record;
  _src text;
  _src_l text;
  _ins_pos int;
  _upd_pos int;
  _writes boolean;
BEGIN
  FOR _rec IN
    SELECT p.proname AS fname,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_functiondef(p.oid) AS src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    IF _rec.fname = ANY(_meta_exempt) THEN
      CONTINUE;
    END IF;

    _src := _rec.src;
    _src_l := lower(_src);
    _writes := false;

    _ins_pos := position('insert into accounts' in _src_l);
    IF _ins_pos = 0 THEN _ins_pos := position('insert into public.accounts' in _src_l); END IF;
    IF _ins_pos > 0 THEN
      IF position('system_role' in substr(_src_l, _ins_pos, 500)) > 0
         OR position('is_system' in substr(_src_l, _ins_pos, 500)) > 0 THEN
        _writes := true;
      END IF;
    END IF;

    IF NOT _writes THEN
      _upd_pos := position('update accounts' in _src_l);
      IF _upd_pos = 0 THEN _upd_pos := position('update public.accounts' in _src_l); END IF;
      IF _upd_pos > 0 THEN
        IF position('system_role' in substr(_src_l, _upd_pos, 800)) > 0
           OR position('is_system' in substr(_src_l, _upd_pos, 800)) > 0 THEN
          _writes := true;
        END IF;
      END IF;
    END IF;

    IF _writes AND NOT (_rec.fname = ANY(_allow)) THEN
      function_name := _rec.fname;
      signature := _rec.fname || '(' || _rec.args || ')';
      reason := 'writes accounts.system_role or accounts.is_system but not on enforce_system_account_helper allowlist';
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_system_account_writer_allowlist() TO authenticated, service_role;

DO $$
DECLARE
  v_violations int;
  v_names text;
BEGIN
  SELECT count(*), string_agg(function_name, ', ')
    INTO v_violations, v_names
    FROM public.audit_system_account_writer_allowlist();

  IF v_violations > 0 THEN
    RAISE EXCEPTION 'allowlist drift: % function(s) write accounts.system_role/is_system outside allowlist: %', v_violations, v_names;
  END IF;

  RAISE NOTICE 'allowlist drift check: 0 violations';
END;
$$;
