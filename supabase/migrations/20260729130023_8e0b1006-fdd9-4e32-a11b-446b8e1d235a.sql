-- Phase 3.4 — Event-driven replenishment
CREATE OR REPLACE FUNCTION public._wms_maybe_enqueue_replen(p_product_id uuid, p_location_id uuid)
RETURNS int
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
    SELECT COALESCE(SUM(quantity - COALESCE(reserved_quantity,0)), 0)
      INTO v_onhand
      FROM public.stock_quants
     WHERE location_id = v_rule.pick_location_id
       AND product_id  = v_rule.product_id;

    IF v_onhand >= v_rule.min_qty THEN CONTINUE; END IF;

    -- Skip if an open replen task already targets this pick face.
    SELECT id INTO v_existing
      FROM public.wms_tasks
     WHERE warehouse_id = v_rule.warehouse_id
       AND task_type = 'replenish'
       AND destination_location_id = v_rule.pick_location_id
       AND product_id = v_rule.product_id
       AND state IN ('pending','assigned','in_progress')
     LIMIT 1;
    IF v_existing IS NOT NULL THEN CONTINUE; END IF;

    v_source := COALESCE(v_rule.source_location_id, public._wms_default_putaway(v_rule.warehouse_id));

    SELECT COALESCE(SUM(quantity - COALESCE(reserved_quantity,0)), 0)
      INTO v_source_onhand
      FROM public.stock_quants
     WHERE location_id = v_source AND product_id = v_rule.product_id;
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
      jsonb_build_object('rule_id', v_rule.id, 'on_hand_before', v_onhand, 'trigger', 'stock_quants')
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
        'trigger',      'stock_quants',
        'occurred_at',  now()
      )
    );

    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END; $function$;

-- Trigger wrapper on stock_quants
CREATE OR REPLACE FUNCTION public._wms_stock_quants_replen_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND
     COALESCE(NEW.quantity,0)          = COALESCE(OLD.quantity,0) AND
     COALESCE(NEW.reserved_quantity,0) = COALESCE(OLD.reserved_quantity,0) THEN
    RETURN NULL;
  END IF;
  PERFORM public._wms_maybe_enqueue_replen(NEW.product_id, NEW.location_id);
  RETURN NULL;
END; $function$;

DROP TRIGGER IF EXISTS trg_stock_quants_replen ON public.stock_quants;
CREATE TRIGGER trg_stock_quants_replen
AFTER INSERT OR UPDATE OF quantity, reserved_quantity ON public.stock_quants
FOR EACH ROW EXECUTE FUNCTION public._wms_stock_quants_replen_trigger();