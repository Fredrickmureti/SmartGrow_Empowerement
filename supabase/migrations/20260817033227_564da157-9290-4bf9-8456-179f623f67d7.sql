-- INV-SIM 2026-08-17: wms_lpn_dispatch / wms_lpn_retire / wms_lpn_receive_return
-- pass wms_lpn_status enums into _wms_lpn_log(_from_status text, _to_status text)
-- => 42883 at runtime. Same class of defect as wms_lpn_seal. Patch the stored
-- definitions in place by casting the status arguments to text.
DO $fix$
DECLARE
  v_name text;
  v_def  text;
  v_new  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['wms_lpn_dispatch','wms_lpn_retire','wms_lpn_receive_return'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'INV-SIM: % is missing', v_name;
    END IF;

    v_new := regexp_replace(v_def, '(\m)v_from,\s*l\.status,', 'v_from::text, l.status::text,', 'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION 'INV-SIM: could not locate the untyped status log arguments in %', v_name;
    END IF;

    EXECUTE v_new;
  END LOOP;
END $fix$;

-- Ratchet: no wms_lpn_* function may pass a non-text status into the log helper.
DO $guard$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname LIKE 'wms_lpn_%'
     AND pg_get_functiondef(p.oid) ~ '_wms_lpn_log\([^;]*\ml\.status,';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'INV-SIM: plate log call still passes an enum status in: %', v_bad;
  END IF;
END $guard$;