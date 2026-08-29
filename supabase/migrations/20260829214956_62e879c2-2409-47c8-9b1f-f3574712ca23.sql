DO $do$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backfill_account_detail_types' LIMIT 1;

  v_new := replace(
    v_def,
    E'WHERE a.detail_type IS NULL\n',
    E'WHERE a.detail_type IS NULL\n      AND coalesce(a.is_header, false) = false\n'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected where clause not found';
  END IF;

  EXECUTE v_new;
END
$do$;