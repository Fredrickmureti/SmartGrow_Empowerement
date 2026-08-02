-- Phase 4.5 — replay dispatcher gap. MobilePlate.tsx enqueues `wms_lpn_move`,
-- but the dispatcher had no branch for it, so every offline plate move failed
-- on drain with WMS_REPLAY_UNKNOWN_RPC. Register it so the move is ledgered and
-- idempotent like every other mobile scan intent.
CREATE OR REPLACE FUNCTION public._wms_replay_lpn_move(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_license_plates;
BEGIN
  SELECT * INTO v_row FROM public.wms_lpn_move(
    (p_args->>'_lpn_id')::uuid,
    NULLIF(p_args->>'_to_location_id','')::uuid,
    NULLIF(p_args->>'_expected_version','')::int,
    NULLIF(p_args->>'_reason','')
  );
  RETURN COALESCE(to_jsonb(v_row), 'null'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public._wms_replay_lpn_move(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._wms_replay_lpn_move(jsonb) TO service_role;