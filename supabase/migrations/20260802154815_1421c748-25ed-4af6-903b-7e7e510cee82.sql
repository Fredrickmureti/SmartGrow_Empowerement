CREATE OR REPLACE FUNCTION public._wms_replay_lpn_set_packaging(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE(
    public.wms_lpn_set_packaging(
      (p_args->>'_lpn_id')::uuid,
      (p_args->>'_packaging_type_id')::uuid,
      NULLIF(p_args->>'_expected_version','')::integer
    ),
    'null'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public._wms_replay_lpn_set_packaging(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_replay_lpn_set_packaging(jsonb) TO service_role;

DO $do$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'wms_replay_guarded_call'
    AND pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'wms_replay_guarded_call not found';
  END IF;

  IF position('wms_lpn_set_packaging' in v_def) > 0 THEN
    RAISE NOTICE 'already registered';
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    E'    WHEN ''wms_lpn_move'' THEN',
    E'    -- Phase 5 (ADR 0105 §7): packaging identity on handling units.\n    WHEN ''wms_lpn_set_packaging'' THEN\n      v_result := public._wms_replay_lpn_set_packaging(p_args);\n\n    WHEN ''wms_lpn_move'' THEN'
  );

  IF position('wms_lpn_set_packaging' in v_def) = 0 THEN
    RAISE EXCEPTION 'failed to splice wms_lpn_set_packaging into dispatcher';
  END IF;

  EXECUTE v_def;
END;
$do$;