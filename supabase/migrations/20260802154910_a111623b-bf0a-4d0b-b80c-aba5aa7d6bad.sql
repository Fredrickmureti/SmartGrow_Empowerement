CREATE OR REPLACE FUNCTION public._wms_replay_lpn_set_packaging(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.wms_license_plates;
BEGIN
  v_row := public.wms_lpn_set_packaging(
    (p_args->>'_lpn_id')::uuid,
    (p_args->>'_packaging_type_id')::uuid,
    NULLIF(p_args->>'_expected_version','')::integer
  );
  RETURN COALESCE(to_jsonb(v_row), 'null'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public._wms_replay_lpn_set_packaging(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_replay_lpn_set_packaging(jsonb) TO service_role;