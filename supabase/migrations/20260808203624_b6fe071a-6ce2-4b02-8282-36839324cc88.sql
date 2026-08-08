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
           st.account_type::text AS account_type,
           st.detail_type::text  AS detail_type,
           st.suggested_code,
           st.suggested_name,
           st.description,
           st.parent_code_hint
      FROM public.system_account_roles sr
      JOIN public.system_account_template st USING (role_key)
     WHERE sr.category <> 'payroll'
     ORDER BY sr.sort_order, sr.role_key
  LOOP
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

    SELECT a.id INTO v_acct_id
      FROM public.accounts a
     WHERE a.business_id = _business_id
       AND a.system_role = r.rk
       AND coalesce(a.is_active, true) = true
     LIMIT 1;

    v_status := CASE WHEN v_acct_id IS NOT NULL THEN 'mapped_existing' ELSE NULL END;

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

DO $$
DECLARE b record; v_err text := '';
BEGIN
  FOR b IN SELECT id, organization_id FROM public.businesses LOOP
    BEGIN
      PERFORM public.ensure_default_account_mappings(b.organization_id, b.id);
    EXCEPTION WHEN OTHERS THEN
      v_err := v_err || b.id::text || ': ' || SQLERRM || '; ';
    END;
  END LOOP;
  IF v_err <> '' THEN
    RAISE NOTICE 'ensure_default_account_mappings issues: %', v_err;
  END IF;
END $$;