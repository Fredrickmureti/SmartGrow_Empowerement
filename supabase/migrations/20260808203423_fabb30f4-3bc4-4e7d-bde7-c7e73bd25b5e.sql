-- Enterprise parity (Odoo/Oracle): a chart template must guarantee that every
-- standard "property account" role resolves to a concrete account. Today
-- provision_missing_system_accounts short-circuits on 'already_eligible'
-- (some account of the right shape exists), which leaves the role itself
-- unmapped in default_account_settings — e.g. `operating_expenses`, the
-- purchase/expense default used by products. Postings then fail late.

CREATE OR REPLACE FUNCTION public.ensure_default_account_mappings(
  _org_id uuid,
  _business_id uuid
)
RETURNS TABLE(role_key text, account_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_acct_id  uuid;
  v_parent   uuid;
  v_status   text;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'ensure_default_account_mappings requires organization_id and business_id'
      USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT sr.role_key AS rk,
           st.account_type,
           st.detail_type,
           st.suggested_code,
           st.suggested_name,
           st.description,
           st.parent_code_hint
      FROM public.system_account_roles sr
      JOIN public.system_account_template st USING (role_key)
     -- Statutory payroll roles are owned by the country payroll packs.
     WHERE sr.category <> 'payroll'
     ORDER BY sr.sort_order, sr.role_key
  LOOP
    -- Already mapped at company level? Nothing to do.
    IF EXISTS (
      SELECT 1 FROM public.default_account_settings d
       WHERE d.organization_id = _org_id
         AND d.business_id = _business_id
         AND d.branch_id IS NULL
         AND d.setting_key = r.rk
    ) THEN
      role_key := r.rk; account_id := NULL; status := 'already_mapped';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 1) Canonical account already carries the role.
    SELECT a.id INTO v_acct_id
      FROM public.accounts a
     WHERE a.business_id = _business_id
       AND a.system_role = r.rk
       AND coalesce(a.is_active, true) = true
     LIMIT 1;

    v_status := CASE WHEN v_acct_id IS NOT NULL THEN 'mapped_existing' ELSE NULL END;

    -- 2) Otherwise let the canonical helper adopt a matching orphan system
    --    account or create the standard one (collision-safe code).
    IF v_acct_id IS NULL THEN
      v_parent := NULL;
      IF r.parent_code_hint IS NOT NULL THEN
        SELECT a.id INTO v_parent
          FROM public.accounts a
         WHERE a.business_id = _business_id
           AND a.code = r.parent_code_hint
         LIMIT 1;
      END IF;

      BEGIN
        v_acct_id := public.upsert_system_account(
          _org_id, _business_id, r.rk,
          r.account_type, r.detail_type,
          r.suggested_code, r.suggested_name,
          r.description, v_parent, false
        );
        v_status := 'provisioned';
      EXCEPTION WHEN OTHERS THEN
        role_key := r.rk; account_id := NULL; status := 'error: ' || SQLERRM;
        RETURN NEXT;
        CONTINUE;
      END;
    END IF;

    IF v_acct_id IS NULL THEN
      role_key := r.rk; account_id := NULL; status := 'unresolved';
      RETURN NEXT;
      CONTINUE;
    END IF;

    INSERT INTO public.default_account_settings
      (organization_id, business_id, branch_id, setting_key, account_id)
    VALUES (_org_id, _business_id, NULL, r.rk, v_acct_id)
    ON CONFLICT DO NOTHING;

    role_key := r.rk; account_id := v_acct_id; status := v_status;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_default_account_mappings(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_default_account_mappings(uuid, uuid) TO authenticated, service_role;

-- Wire it into provisioning so new companies are complete on day one.
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid, _business_id uuid, _country_code text DEFAULT NULL::text
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

  -- Every standard role must resolve to a concrete mapped account.
  PERFORM public.ensure_default_account_mappings(_org_id, _business_id);

  RETURN _accounts_created;
END;
$function$;

-- One-off repair for existing companies.
DO $$
DECLARE b record;
BEGIN
  FOR b IN SELECT id, organization_id FROM public.businesses LOOP
    BEGIN
      PERFORM public.ensure_default_account_mappings(b.organization_id, b.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ensure_default_account_mappings failed for business %: %', b.id, SQLERRM;
    END;
  END LOOP;
END $$;