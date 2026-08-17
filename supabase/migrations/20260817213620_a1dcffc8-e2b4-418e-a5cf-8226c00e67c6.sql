CREATE OR REPLACE FUNCTION public.get_count_lines(p_session_id uuid)
RETURNS TABLE(
  id uuid, location_id uuid, location_code text, location_name text,
  product_id uuid, product_sku text, product_name text, lot_number text,
  system_qty numeric, counted_qty numeric, entered_qty numeric,
  packaging_id uuid, packaging_name text, variance_qty numeric,
  variance_reason text, tolerance_outcome text, approval_state text,
  approval_actor_id uuid, approval_at timestamptz, approval_note text,
  assigned_to uuid, serial_numbers text[], expiry_date date,
  recount_of_line_id uuid, recount_round integer,
  counted_at timestamptz, counted_by uuid, is_blind boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_pc record;
  v_hide boolean := false;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id;

  IF v_session.id IS NULL THEN
    -- Inventory-module count: no warehouse session exists, read the
    -- canonical physical count lines instead.
    SELECT * INTO v_pc FROM public.physical_counts WHERE id = p_session_id;
    IF v_pc.id IS NULL THEN
      RAISE EXCEPTION 'count % not found', p_session_id USING ERRCODE = 'P0001';
    END IF;
    IF NOT public.user_can_access_business(auth.uid(), v_pc.business_id) THEN
      RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
      pcl.id,
      pcl.bin_id,
      sl.code,
      sl.name,
      pcl.product_id,
      p.sku,
      p.name,
      NULL::text,
      COALESCE(pcl.system_qty_at_freeze, 0) + COALESCE(pcl.freeze_reconciliation_qty, 0),
      COALESCE(pcl.recount_qty, pcl.counted_qty),
      pcl.counted_qty,
      pcl.packaging_id,
      pk.name,
      pcl.variance_qty,
      NULL::text,
      pcl.status::text,
      CASE
        WHEN v_pc.state = 'posted' THEN 'approved'
        WHEN v_pc.state IN ('cancelled', 'superseded') THEN 'rejected'
        ELSE 'pending'
      END,
      CASE WHEN v_pc.state = 'posted' THEN COALESCE(v_pc.approved_by, v_pc.posted_by) ELSE NULL END,
      CASE WHEN v_pc.state = 'posted' THEN COALESCE(v_pc.approved_at, v_pc.posted_at) ELSE NULL END,
      NULL::text,
      NULL::uuid,
      NULL::text[],
      NULL::date,
      NULL::uuid,
      CASE WHEN pcl.recount_qty IS NOT NULL THEN 2 ELSE 1 END,
      pcl.counted_at,
      pcl.counted_by,
      false
      FROM public.physical_count_lines pcl
      LEFT JOIN public.stock_locations sl ON sl.id = pcl.bin_id
      LEFT JOIN public.products p ON p.id = pcl.product_id
      LEFT JOIN public.product_packaging pk ON pk.id = pcl.packaging_id
     WHERE pcl.count_id = v_pc.id
     ORDER BY p.name;
    RETURN;
  END IF;

  IF NOT public.user_can_access_business(auth.uid(), v_session.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  v_hide := COALESCE(v_session.is_blind, false) AND v_session.state IN ('open', 'counting');

  RETURN QUERY
  SELECT
    l.id, l.location_id, sl.code, sl.name,
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
    l.approval_state,
    l.approval_actor_id,
    l.approval_at,
    l.approval_note,
    l.assigned_to,
    l.serial_numbers,
    l.expiry_date,
    l.recount_of_line_id,
    l.recount_round,
    l.counted_at,
    l.counted_by,
    v_session.is_blind
  FROM public.wms_count_lines l
  LEFT JOIN public.stock_locations sl ON sl.id = l.location_id
  LEFT JOIN public.products p ON p.id = l.product_id
  LEFT JOIN public.product_packaging pk ON pk.id = l.packaging_id
  WHERE l.session_id = p_session_id
  ORDER BY sl.code NULLS LAST, p.name;
END $function$;

GRANT EXECUTE ON FUNCTION public.get_count_lines(uuid) TO authenticated, service_role;
