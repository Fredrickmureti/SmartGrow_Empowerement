-- Inventory Foundation Wave · Phase 8c
-- Give the canonical availability engine a location (bin) grain so the last
-- allowlisted second formula (_wms_maybe_enqueue_replen) can be retired.

DROP FUNCTION IF EXISTS public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid);

CREATE FUNCTION public.resolve_stock_availability_batch(
  p_product_ids        uuid[],
  p_business_id        uuid,
  p_branch_id          uuid  DEFAULT NULL,
  p_warehouse_id       uuid  DEFAULT NULL,
  p_exclude_source_type text DEFAULT NULL,
  p_exclude_source_id  uuid  DEFAULT NULL,
  p_location_ids       uuid[] DEFAULT NULL
)
RETURNS TABLE(product_id uuid, on_hand numeric, reserved numeric, blocked numeric, in_transit numeric, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_product_ids IS NULL OR array_length(p_product_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF p_business_id IS NULL AND p_warehouse_id IS NULL
     AND (p_location_ids IS NULL OR array_length(p_location_ids, 1) IS NULL) THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_SCOPE: a business, a warehouse or a location is required';
  END IF;
  IF p_business_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied for business %', p_business_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT u AS product_id FROM unnest(p_product_ids) AS u WHERE u IS NOT NULL
  ),
  quants AS (
    SELECT
      q.product_id,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'internal'
          AND COALESCE(l.is_blocked, false) = false
          AND COALESCE(w.is_in_transit, false) = false
      ), 0) AS on_hand,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'quarantine' OR COALESCE(l.is_blocked, false)
      ), 0) AS blocked,
      COALESCE(SUM(q.quantity) FILTER (
        WHERE l.location_type = 'transit' OR COALESCE(w.is_in_transit, false)
      ), 0) AS in_transit
    FROM public.stock_quants q
    JOIN public.stock_locations l ON l.id = q.location_id
    LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
    WHERE q.product_id = ANY (p_product_ids)
      AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
      AND (p_business_id  IS NULL OR q.business_id  = p_business_id)
      AND (p_branch_id    IS NULL OR q.branch_id    = p_branch_id)
      AND (p_location_ids IS NULL OR q.location_id  = ANY (p_location_ids))
    GROUP BY q.product_id
  ),
  holds AS (
    SELECT r.product_id, COALESCE(SUM(r.quantity), 0) AS reserved
    FROM public.stock_reservations r
    LEFT JOIN public.warehouses w ON w.id = r.warehouse_id
    WHERE r.product_id = ANY (p_product_ids)
      AND public.stock_reservation_is_open(r.status, r.expires_at)
      AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
      AND (p_business_id  IS NULL OR r.business_id  = p_business_id)
      AND (p_branch_id    IS NULL OR r.branch_id    = p_branch_id)
      -- Location grain: only holds pinned to one of the requested bins count.
      AND (p_location_ids IS NULL OR r.location_id = ANY (p_location_ids))
      AND COALESCE(w.is_in_transit, false) = false
      AND NOT (
        p_exclude_source_type IS NOT NULL
        AND r.source_type = p_exclude_source_type
        AND (p_exclude_source_id IS NULL OR r.source_id = p_exclude_source_id)
      )
    GROUP BY r.product_id
  )
  SELECT
    i.product_id,
    COALESCE(q.on_hand, 0)::numeric,
    COALESCE(h.reserved, 0)::numeric,
    COALESCE(q.blocked, 0)::numeric,
    COALESCE(q.in_transit, 0)::numeric,
    (COALESCE(q.on_hand, 0) - COALESCE(h.reserved, 0))::numeric
  FROM ids i
  LEFT JOIN quants q ON q.product_id = i.product_id
  LEFT JOIN holds  h ON h.product_id = i.product_id;
END $function$;

REVOKE ALL ON FUNCTION public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_stock_availability_batch(uuid[], uuid, uuid, uuid, text, uuid, uuid[]) TO authenticated, service_role;

-- Retire the last second formula: bin-grain replenishment now asks the engine.
CREATE OR REPLACE FUNCTION public._wms_maybe_enqueue_replen(p_product_id uuid, p_location_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule record;
  v_onhand numeric;
  v_source uuid;
  v_source_onhand numeric;
  v_needed numeric;
  v_task_id uuid;
  v_existing uuid;
  v_created int := 0;
BEGIN
  IF p_product_id IS NULL OR p_location_id IS NULL THEN RETURN 0; END IF;

  FOR v_rule IN
    SELECT r.*, w.organization_id AS wh_org, w.branch_id AS wh_branch
      FROM public.wms_replenishment_rules r
      JOIN public.warehouses w ON w.id = r.warehouse_id
     WHERE r.is_active = true
       AND r.product_id = p_product_id
       AND r.pick_location_id = p_location_id
     ORDER BY r.priority ASC
  LOOP
    SELECT COALESCE(a.available, 0) INTO v_onhand
      FROM public.resolve_stock_availability_batch(
             ARRAY[v_rule.product_id]::uuid[], v_rule.business_id, NULL, NULL, NULL, NULL,
             ARRAY[v_rule.pick_location_id]::uuid[]) a;
    v_onhand := COALESCE(v_onhand, 0);

    IF v_onhand >= v_rule.min_qty THEN CONTINUE; END IF;

    SELECT id INTO v_existing
      FROM public.wms_tasks
     WHERE warehouse_id = v_rule.warehouse_id
       AND task_type = 'replenish'
       AND destination_location_id = v_rule.pick_location_id
       AND product_id = v_rule.product_id
       AND state IN ('pending','claimed','in_progress')
     LIMIT 1;
    IF v_existing IS NOT NULL THEN CONTINUE; END IF;

    v_source := COALESCE(v_rule.source_location_id, public._wms_default_putaway(v_rule.warehouse_id));

    SELECT COALESCE(a.available, 0) INTO v_source_onhand
      FROM public.resolve_stock_availability_batch(
             ARRAY[v_rule.product_id]::uuid[], v_rule.business_id, NULL, NULL, NULL, NULL,
             ARRAY[v_source]::uuid[]) a;
    v_source_onhand := COALESCE(v_source_onhand, 0);
    IF v_source_onhand <= 0 THEN CONTINUE; END IF;

    v_needed := v_rule.max_qty - v_onhand;
    IF v_rule.pack_multiple > 1 THEN
      v_needed := ceil(v_needed / v_rule.pack_multiple) * v_rule.pack_multiple;
    END IF;
    v_needed := LEAST(v_needed, v_source_onhand);
    IF v_needed <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_location_id, destination_location_id,
      product_id, quantity,
      source_doc_type, source_doc_id,
      notes, created_by, metadata
    ) VALUES (
      v_rule.wh_org, v_rule.business_id, v_rule.wh_branch, v_rule.warehouse_id,
      'replenish', 'pending', v_rule.priority,
      v_source, v_rule.pick_location_id,
      v_rule.product_id, v_needed,
      'wms_replenishment_rule', v_rule.id,
      'Auto replenishment (event-triggered, min=' || v_rule.min_qty || ', max=' || v_rule.max_qty || ')',
      NULL,
      jsonb_build_object('rule_id', v_rule.id, 'on_hand_before', v_onhand, 'trigger', 'availability_engine')
    ) RETURNING id INTO v_task_id;

    UPDATE public.wms_replenishment_rules SET last_run_at = now() WHERE id = v_rule.id;

    PERFORM public._wms_emit_outbox(
      'warehouse.replen.enqueued',
      'wms.replen:' || v_rule.product_id::text || ':' || v_rule.pick_location_id::text
        || ':' || to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'),
      v_rule.wh_org, v_rule.business_id,
      jsonb_build_object(
        'aggregate_id', v_task_id,
        'warehouse_id', v_rule.warehouse_id,
        'branch_id',    v_rule.wh_branch,
        'product_id',   v_rule.product_id,
        'pick_location_id', v_rule.pick_location_id,
        'source_location_id', v_source,
        'rule_id',      v_rule.id,
        'quantity',     v_needed,
        'on_hand_before', v_onhand,
        'trigger',      'availability_engine',
        'occurred_at',  now()
      )
    );

    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END; $function$;