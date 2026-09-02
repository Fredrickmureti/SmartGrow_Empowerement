DO $$
DECLARE r record; v_def text; v_new text;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'mf\_%' AND p.prosrc LIKE '%super_admin%'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      '(public\.)?has_role\(([^,()]+),\s*''super_admin''\)',
      '(public.has_role(\2, ''super_admin'') OR public.has_role(\2, ''owner''))',
      'g');
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END $$;