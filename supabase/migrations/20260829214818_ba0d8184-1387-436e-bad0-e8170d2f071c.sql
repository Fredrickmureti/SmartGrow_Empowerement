DO $do$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'provision_default_chart_of_accounts' LIMIT 1;

  v_new := replace(
    v_def,
    E'_norm_account_type::public.account_type, _template.detail_type,\n          _parent_id, _template.description,\n          false, _is_header, true',
    E'_norm_account_type::public.account_type,\n          CASE WHEN _is_header THEN NULL ELSE _template.detail_type END,\n          _parent_id, _template.description,\n          false, _is_header, true'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected insert expression not found';
  END IF;

  EXECUTE v_new;
END
$do$;