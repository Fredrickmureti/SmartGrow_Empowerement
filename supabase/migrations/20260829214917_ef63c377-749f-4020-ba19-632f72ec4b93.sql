DO $do$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'upsert_system_account' LIMIT 1;

  v_new := replace(
    v_def,
    '_account_type::public.account_type, _detail_type,',
    '_account_type::public.account_type, CASE WHEN coalesce(_is_header, false) THEN NULL ELSE _detail_type END,'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected detail_type expression not found';
  END IF;

  EXECUTE v_new;
END
$do$;