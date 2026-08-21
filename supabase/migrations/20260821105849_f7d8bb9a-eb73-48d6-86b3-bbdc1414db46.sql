-- Rounding to 2dp must not be imposed on base-currency entries: some callers
-- post fractional-cent inventory amounts that balance only at full precision.
-- Round only on the FX conversion path.
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_journal_entry_atomic';

  v_new := replace(v_def,
    'v_od := ROUND(COALESCE((v_line->>''debit'')::numeric, 0), 2);
    v_oc := ROUND(COALESCE((v_line->>''credit'')::numeric, 0), 2);',
    'v_od := COALESCE((v_line->>''debit'')::numeric, 0);
    v_oc := COALESCE((v_line->>''credit'')::numeric, 0);');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'rounding patch did not match post_journal_entry_atomic';
  END IF;

  EXECUTE v_new;
END $mig$;
