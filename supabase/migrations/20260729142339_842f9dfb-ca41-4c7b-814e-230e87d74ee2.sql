
-- ─── 1. Unified labour queue view ────────────────────────────────────
CREATE OR REPLACE VIEW public.wms_labour_queue_view
WITH (security_invoker = true) AS
SELECT
  t.id                       AS task_id,
  t.task_type,
  t.state,
  t.priority,
  t.sla_at,
  t.warehouse_id,
  t.branch_id,
  t.organization_id,
  t.business_id,
  t.zone_id,
  t.assignee_user_id,
  t.claimed_by,
  t.claimed_at,
  t.expires_at,
  t.source_location_id,
  t.destination_location_id,
  t.product_id,
  t.lot_number,
  t.lpn_id,
  t.quantity,
  t.source_doc_type,
  t.source_doc_id,
  t.row_version,
  t.created_at,
  t.updated_at,
  (t.sla_at IS NOT NULL AND t.sla_at < now()) AS sla_breached
FROM public.wms_tasks t
WHERE t.state IN ('pending','available','assigned','claimed','in_progress')
  AND t.expires_at IS NULL OR t.expires_at > now();

REVOKE ALL ON public.wms_labour_queue_view FROM PUBLIC;
GRANT SELECT ON public.wms_labour_queue_view TO authenticated;

COMMENT ON VIEW public.wms_labour_queue_view IS
'Phase 3.6 — Single labour queue across every open WMS task type. Fed to LabourBoard supervisors and the mobile RF "next task" surface. RLS is inherited from wms_tasks via security_invoker=true.';

-- ─── 2. Cross-dock cascade → stage-for-dispatch task ────────────────
CREATE OR REPLACE FUNCTION public.evaluate_crossdock_on_receiving_line(p_line_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line  public.wms_receiving_lines;
  v_wh    public.warehouses;
  v_biz   uuid;
  v_soi   record;
  v_row   public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_line FROM public.wms_receiving_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF COALESCE(v_line.received_qty, 0) <= 0 OR v_line.product_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = v_line.warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_biz := v_wh.business_id;

  IF EXISTS (
    SELECT 1 FROM public.wms_crossdock_opportunities
     WHERE business_id = v_biz AND receiving_line_id = p_line_id
  ) THEN
    RETURN 0;
  END IF;

  SELECT soi.id AS soi_id, so.id AS so_id, so.branch_id AS so_branch
    INTO v_soi
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.sales_order_id
   WHERE so.business_id = v_biz
     AND soi.product_id = v_line.product_id
     AND so.status IN ('confirmed','processing','partial')
     AND (COALESCE(soi.quantity, 0) - COALESCE(soi.quantity_fulfilled, 0)) > 0
   ORDER BY so.order_date ASC, so.created_at ASC
   LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  INSERT INTO public.wms_crossdock_opportunities (
    business_id, organization_id, branch_id, warehouse_id,
    receiving_line_id, product_id, quantity,
    sales_order_id, sales_order_item_id, status
  ) VALUES (
    v_biz, v_wh.organization_id, COALESCE(v_wh.branch_id, v_soi.so_branch), v_line.warehouse_id,
    p_line_id, v_line.product_id, v_line.received_qty,
    v_soi.so_id, v_soi.soi_id, 'open'
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    PERFORM public.emit_crossdock_event('warehouse.crossdock.matched', v_row);

    -- Phase 3.6: also seed a stage-for-dispatch task so the unified
    -- labour queue picks it up. Cross-dock bypasses putaway, so operators
    -- see one clear "pack for dispatch" action instead of a phantom
    -- put-away that would immediately be undone.
    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_location_id, destination_location_id,
      product_id, quantity,
      source_doc_type, source_doc_id,
      notes, created_by
    ) VALUES (
      v_row.organization_id, v_row.business_id, v_row.branch_id, v_row.warehouse_id,
      'pack'::wms_task_type, 'available'::wms_task_state, 150,
      NULL, NULL,
      v_row.product_id, v_row.quantity,
      'wms_crossdock_opportunity', v_row.id,
      'Cross-dock: stage for dispatch (auto-generated).',
      auth.uid()
    );

    RETURN 1;
  END IF;
  RETURN 0;
END $function$;
