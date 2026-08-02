-- Phase 6.1 (ADR 0105): packaging supply consumption is server-only.
REVOKE ALL ON FUNCTION public.wms_packaging_consume(uuid, uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wms_packaging_consume(uuid, uuid, uuid, numeric, text, uuid) TO service_role;

-- Legacy carton catalogue is read-only until Phase 8 drops it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.wms_carton_types FROM authenticated;
REVOKE ALL ON public.wms_carton_types FROM anon;
REVOKE ALL ON FUNCTION public.suggest_carton(uuid, uuid[], numeric[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_carton_to_pack(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_carton(uuid, uuid[], numeric[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_carton_to_pack(uuid, uuid) TO service_role;