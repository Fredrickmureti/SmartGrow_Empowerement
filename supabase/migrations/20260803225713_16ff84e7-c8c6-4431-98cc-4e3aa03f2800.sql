GRANT EXECUTE ON FUNCTION public.wms_crossdock_approve(uuid, integer, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_reject(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_start_staging(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_confirm_staged(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_mark_loaded(uuid, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_complete(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_break(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_sweep_expired() TO authenticated;