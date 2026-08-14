DROP FUNCTION IF EXISTS public.get_count_lines(uuid);

CREATE OR REPLACE FUNCTION public.get_count_lines(p_session_id uuid)
 RETURNS TABLE(id uuid, location_id uuid, location_code text, location_name text, product_id uuid, product_sku text, product_name text, lot_number text, system_qty numeric, counted_qty numeric, entered_qty numeric, packaging_id uuid, packaging_name text, variance_qty numeric, variance_reason text, tolerance_outcome text, assigned_to uuid, serial_numbers text[], expiry_date date, recount_of_line_id uuid, recount_round integer, counted_at timestamp with time zone, is_blind boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_session record; v_hide boolean;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE wms_count_sessions.id = p_session_id;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  -- Expected figures reappear once the session reaches review.
  v_hide := v_session.is_blind AND v_session.state IN ('draft','counting');

  RETURN QUERY
  SELECT l.id,
         l.location_id, sl.code, sl.name,
         l.product_id, p.sku, p.name,
         l.lot_number,
         CASE WHEN v_hide THEN NULL ELSE l.system_qty END,
         l.counted_qty,
         l.entered_qty,
         l.packaging_id,
         pk.name,
         CASE WHEN v_hide THEN NULL ELSE l.variance_qty END,
         l.variance_reason::text,
         l.tolerance_outcome,
         l.assigned_to,
         l.serial_numbers,
         l.expiry_date,
         l.recount_of_line_id,
         l.recount_round,
         l.counted_at,
         v_session.is_blind
    FROM public.wms_count_lines l
    LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
    LEFT JOIN public.products p ON p.id = l.product_id
    LEFT JOIN public.product_packaging pk ON pk.id = l.packaging_id
   WHERE l.session_id = p_session_id
   ORDER BY sl.code NULLS LAST, p.name;
END $function$;