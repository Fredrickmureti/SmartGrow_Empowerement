-- Cycle-count paperwork must resolve for counts created in the Inventory
-- module (public.physical_counts) as well as Warehouse-app sessions
-- (public.wms_count_sessions). Same document pipeline, two possible ids.

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
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_id;
  IF v_session.id IS NOT NULL THEN
    SELECT * INTO v_pc FROM public.physical_counts WHERE id = v_session.physical_count_id;
  ELSE
    SELECT * INTO v_pc FROM public.physical_counts WHERE id = p_id;
    IF v_pc.id IS NULL THEN
      RAISE EXCEPTION 'count % not found', p_id USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_session FROM public.wms_count_sessions
     WHERE physical_count_id = v_pc.id LIMIT 1;
  END IF;

  v_biz := COALESCE(v_session.business_id, v_pc.business_id);
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT name, code INTO v_wh FROM public.warehouses
   WHERE id = COALESCE(v_session.warehouse_id, v_pc.warehouse_id);

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

-- Sign-offs: resolve from either id, and fall back to the canonical
-- physical_counts audit columns when there is no warehouse session.
CREATE OR REPLACE FUNCTION public.get_count_signoffs(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_session record;
  v_pc record;
  v_biz uuid;
  v_counters jsonb;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id;
  IF v_session.id IS NOT NULL THEN
    SELECT * INTO v_pc FROM public.physical_counts WHERE id = v_session.physical_count_id;
  ELSE
    SELECT * INTO v_pc FROM public.physical_counts WHERE id = p_session_id;
    IF v_pc.id IS NULL THEN
      RAISE EXCEPTION 'count % not found', p_session_id USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_session FROM public.wms_count_sessions
     WHERE physical_count_id = v_pc.id LIMIT 1;
  END IF;

  v_biz := COALESCE(v_session.business_id, v_pc.business_id);
  IF NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_agg(DISTINCT jsonb_build_object('user_id', c.user_id, 'name', c.name))
    INTO v_counters
    FROM (
      SELECT l.counted_by AS user_id, COALESCE(pr.full_name, pr.email) AS name
        FROM public.wms_count_lines l
        LEFT JOIN public.profiles pr ON pr.user_id = l.counted_by
       WHERE v_session.id IS NOT NULL
         AND l.session_id = v_session.id
         AND l.counted_by IS NOT NULL
      UNION
      SELECT pcl.counted_by, COALESCE(pr.full_name, pr.email)
        FROM public.physical_count_lines pcl
        LEFT JOIN public.profiles pr ON pr.user_id = pcl.counted_by
       WHERE v_pc.id IS NOT NULL
         AND pcl.count_id = v_pc.id
         AND pcl.counted_by IS NOT NULL
    ) c;

  RETURN jsonb_build_object(
    'counted_by', COALESCE(v_counters, '[]'::jsonb),
    'reviewed_by', jsonb_build_object(
      'user_id', v_pc.submitted_by,
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = v_pc.submitted_by),
      'at', v_pc.submitted_at),
    'approved_by', jsonb_build_object(
      'user_id', v_pc.approved_by,
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = v_pc.approved_by),
      'at', v_pc.approved_at),
    'posted_by', jsonb_build_object(
      'user_id', COALESCE(v_pc.posted_by, v_session.posted_by),
      'name', (SELECT COALESCE(full_name, email) FROM public.profiles WHERE user_id = COALESCE(v_pc.posted_by, v_session.posted_by)),
      'at', COALESCE(v_pc.posted_at, v_session.posted_at))
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.get_count_signoffs(uuid) TO authenticated, service_role;
