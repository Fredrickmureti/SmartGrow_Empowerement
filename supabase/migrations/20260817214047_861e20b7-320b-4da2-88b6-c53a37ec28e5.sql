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
#variable_conflict use_variable
DECLARE
  v_session record;
  v_pc record;
  v_hide boolean := false;
BEGIN
  SELECT s.* INTO v_session FROM public.wms_count_sessions s WHERE s.id = p_session_id;

  IF v_session.id IS NULL THEN
    SELECT c.* INTO v_pc FROM public.physical_counts c WHERE c.id = p_session_id;
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

-- Same hazard in the two functions added alongside it.
CREATE OR REPLACE FUNCTION public.get_count_document_header(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_pc record;
  v_biz uuid;
  v_wh record;
BEGIN
  SELECT s.* INTO v_session FROM public.wms_count_sessions s WHERE s.id = p_id;
  IF v_session.id IS NOT NULL THEN
    SELECT c.* INTO v_pc FROM public.physical_counts c WHERE c.id = v_session.physical_count_id;
  ELSE
    SELECT c.* INTO v_pc FROM public.physical_counts c WHERE c.id = p_id;
    IF v_pc.id IS NULL THEN
      RAISE EXCEPTION 'count % not found', p_id USING ERRCODE = 'P0001';
    END IF;
    SELECT s.* INTO v_session FROM public.wms_count_sessions s
     WHERE s.physical_count_id = v_pc.id LIMIT 1;
  END IF;

  v_biz := COALESCE(v_session.business_id, v_pc.business_id);
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT w.name, w.code INTO v_wh FROM public.warehouses w
   WHERE w.id = COALESCE(v_session.warehouse_id, v_pc.warehouse_id);

  RETURN jsonb_build_object(
    'id',               p_id,
    'code',             COALESCE(v_session.code, v_pc.count_number),
    'state',            COALESCE(v_session.state::text, v_pc.state),
    'strategy',         COALESCE(v_session.strategy::text, v_pc.count_type),
    'is_blind',         COALESCE(v_session.is_blind, false),
    'notes',            COALESCE(v_session.notes, v_pc.notes),
    'organization_id',  COALESCE(v_session.organization_id, v_pc.organization_id),
    'business_id',      v_biz,
    'branch_id',        COALESCE(v_session.branch_id, v_pc.branch_id),
    'warehouse_id',     COALESCE(v_session.warehouse_id, v_pc.warehouse_id),
    'warehouse_name',   v_wh.name,
    'warehouse_code',   v_wh.code,
    'physical_count_id', COALESCE(v_session.physical_count_id, v_pc.id),
    'linked_count_number', v_pc.count_number,
    'requires_approval', COALESCE(v_session.requires_approval, true),
    'created_at',       COALESCE(v_session.created_at, v_pc.created_at),
    'posted_at',        COALESCE(v_pc.posted_at, v_session.posted_at)
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.get_count_document_header(uuid) TO authenticated, service_role;
