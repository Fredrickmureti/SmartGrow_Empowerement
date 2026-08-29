DO $do$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'provision_default_chart_of_accounts' LIMIT 1;

  v_new := replace(
    v_def,
    'IF _template.role_key IS NOT NULL THEN',
    'IF _template.role_key IS NOT NULL AND NOT _is_header THEN'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected role_key condition not found';
  END IF;

  EXECUTE v_new;
END
$do$;