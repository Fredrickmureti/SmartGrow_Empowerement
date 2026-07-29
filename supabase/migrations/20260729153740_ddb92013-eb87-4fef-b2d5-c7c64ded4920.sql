-- Phase 3.7 §grants audit: lock down the four task/LPN lifecycle RPCs that
-- were shipped in migration 20260728231930 without explicit REVOKE/GRANT
-- statements. wms_task_reap_expired stays PUBLIC-callable-by-cron-only.

REVOKE ALL ON FUNCTION public.wms_transition_task(uuid, public.wms_task_state, integer, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_task(uuid, public.wms_task_state, integer, uuid, text, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_transition_lpn(uuid, public.wms_lpn_status, integer, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_transition_lpn(uuid, public.wms_lpn_status, integer, uuid, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_claim_next_task(uuid, public.wms_task_type[], uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_claim_next_task(uuid, public.wms_task_type[], uuid, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_task_heartbeat(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_task_heartbeat(uuid, integer) TO authenticated, service_role;

-- wms_task_reap_expired is a supervisor sweep; keep it revoked from PUBLIC
-- and only grant to service_role for the pg_cron scheduled call.
REVOKE ALL ON FUNCTION public.wms_task_reap_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_task_reap_expired() TO service_role;
