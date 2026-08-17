-- INV-SIM 2026-08-17: wms_lpn_seal passed wms_lpn_status enums into
-- _wms_lpn_log(_from_status text, _to_status text) — 42883 at runtime, so the
-- seal action was dead on every plate. Cast to text.
CREATE OR REPLACE FUNCTION public.wms_lpn_seal(_lpn_id uuid, _expected_version integer)
RETURNS wms_license_plates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET lock_timeout TO '5s'
AS $function$
DECLARE l public.wms_license_plates; v_from public.wms_lpn_status;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_lpn_guard(l);
  IF NOT EXISTS (SELECT 1 FROM public.stock_quants WHERE lpn_id = _lpn_id AND quantity <> 0)
     AND NOT EXISTS (SELECT 1 FROM public.wms_license_plates WHERE parent_lpn_id = _lpn_id) THEN
    RAISE EXCEPTION 'wms_lpn_empty_cannot_seal' USING ERRCODE = '22023';
  END IF;
  v_from := l.status;
  l := public.wms_transition_lpn(_lpn_id, 'sealed'::public.wms_lpn_status,
        public._wms_lpn_require_version(_expected_version), NULL, auth.uid(), NULL);
  UPDATE public.wms_license_plates SET sealed_at = now() WHERE id = _lpn_id RETURNING * INTO l;
  PERFORM public._wms_lpn_log(l, 'sealed', NULL, NULL, v_from::text, l.status::text, NULL, NULL, '{}'::jsonb);
  RETURN l;
END $function$;