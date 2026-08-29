DO $do$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backfill_account_detail_types' LIMIT 1;

  v_new := replace(
    v_def,
    E'WITH upd AS (',
    E'UPDATE public.accounts a
     SET detail_type = t.detail_type
     FROM public.system_account_template t
     WHERE a.system_role = t.role_key
       AND t.detail_type IS NOT NULL
       AND coalesce(a.is_header, false) = false
       AND a.detail_type IS DISTINCT FROM t.detail_type
       AND (_org_id IS NULL OR a.organization_id = _org_id)
       AND (_business_id IS NULL OR a.business_id = _business_id);

  WITH upd AS ('
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected WITH upd not found';
  END IF;

  EXECUTE v_new;
END
$do$;