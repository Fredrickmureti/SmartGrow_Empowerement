DO $do$
DECLARE
  v_src text;
  v_new text;
BEGIN
  v_src := pg_get_functiondef('public.consolidation_generate_eliminations(uuid,date,date)'::regprocedure);

  IF position('m.ownership_percentage' in v_src) = 0 THEN
    RAISE EXCEPTION 'consolidation_generate_eliminations no longer references m.ownership_percentage; refusing to patch blindly';
  END IF;

  v_new := replace(v_src,
    '''ownership_percentage'', m.ownership_percentage',
    '''ownership_percent'', m.ownership_percent');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'expected scope-snapshot ownership expression not found; refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$do$;

DO $do$
BEGIN
  IF position('ownership_percentage' in pg_get_functiondef('public.consolidation_generate_eliminations(uuid,date,date)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'patch did not take effect';
  END IF;
END
$do$;