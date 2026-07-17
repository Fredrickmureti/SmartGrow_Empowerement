
-- 1) additive columns on stock_locations
ALTER TABLE public.stock_locations
  ADD COLUMN IF NOT EXISTS putaway_priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_receiving_staging boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_putaway_target boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_stock_locations_putaway
  ON public.stock_locations(warehouse_id, is_putaway_target, putaway_priority DESC)
  WHERE is_active = true;

-- 2) metadata on wms_tasks
ALTER TABLE public.wms_tasks
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 3) audit table
CREATE TABLE IF NOT EXISTS public.wms_putaway_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  task_id uuid NOT NULL REFERENCES public.wms_tasks(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  rank integer NOT NULL,
  reason text NOT NULL,
  chosen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_putaway_suggestions TO authenticated;
GRANT ALL ON public.wms_putaway_suggestions TO service_role;

ALTER TABLE public.wms_putaway_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_putaway_suggestions_select ON public.wms_putaway_suggestions
  FOR SELECT TO authenticated
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND ((branch_id IS NULL) OR can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY wms_putaway_suggestions_write ON public.wms_putaway_suggestions
  FOR ALL TO authenticated
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND ((branch_id IS NULL) OR can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND ((branch_id IS NULL) OR can_access_branch(auth.uid(), branch_id))
  );

CREATE INDEX IF NOT EXISTS idx_wms_putaway_suggestions_task
  ON public.wms_putaway_suggestions(task_id);

-- 4) suggest_putaway_locations
CREATE OR REPLACE FUNCTION public.suggest_putaway_locations(
  p_warehouse_id uuid,
  p_product_id uuid,
  p_quantity numeric
)
RETURNS TABLE (location_id uuid, rank integer, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
  v_category uuid;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL OR NOT user_can_access_business(auth.uid(), v_business) THEN
    RETURN;
  END IF;

  SELECT category_id INTO v_category FROM public.products WHERE id = p_product_id;

  RETURN QUERY
  WITH candidates AS (
    -- Bins already holding the same product (consolidate)
    SELECT sl.id AS lid, 1 AS r, 'consolidate_same_product' AS why
    FROM public.stock_locations sl
    JOIN public.stock_quants sq
      ON sq.location_id = sl.id AND sq.product_id = p_product_id
    WHERE sl.warehouse_id = p_warehouse_id
      AND sl.is_active = true
      AND COALESCE(sl.is_putaway_target, false) = true
      AND COALESCE(sl.is_receiving_staging, false) = false

    UNION ALL

    -- Bins already holding the same category
    SELECT sl.id, 2, 'same_category'
    FROM public.stock_locations sl
    JOIN public.stock_quants sq ON sq.location_id = sl.id
    JOIN public.products p ON p.id = sq.product_id AND p.category_id = v_category
    WHERE v_category IS NOT NULL
      AND sl.warehouse_id = p_warehouse_id
      AND sl.is_active = true
      AND COALESCE(sl.is_putaway_target, false) = true
      AND COALESCE(sl.is_receiving_staging, false) = false

    UNION ALL

    -- Any active putaway-eligible bin, priority-ordered
    SELECT sl.id, 3, 'general_priority'
    FROM public.stock_locations sl
    WHERE sl.warehouse_id = p_warehouse_id
      AND sl.is_active = true
      AND COALESCE(sl.is_putaway_target, false) = true
      AND COALESCE(sl.is_receiving_staging, false) = false
  ),
  dedup AS (
    SELECT DISTINCT ON (lid) lid, r, why
    FROM candidates
    ORDER BY lid, r
  )
  SELECT d.lid,
         ROW_NUMBER() OVER (
           ORDER BY d.r ASC,
                    (SELECT putaway_priority FROM public.stock_locations WHERE id = d.lid) DESC NULLS LAST,
                    (SELECT pick_sequence FROM public.stock_locations WHERE id = d.lid) ASC NULLS LAST
         )::integer AS rnk,
         d.why
  FROM dedup d
  LIMIT 10;
END;
$$;

REVOKE ALL ON FUNCTION public.suggest_putaway_locations(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_putaway_locations(uuid, uuid, numeric) TO authenticated, service_role;

-- 5) receive_goods_to_wms
CREATE OR REPLACE FUNCTION public.receive_goods_to_wms(
  p_goods_receipt_id uuid,
  p_staging_location_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gr record;
  v_line record;
  v_lpn_id uuid;
  v_lpn_code text;
  v_dest_id uuid;
  v_task_id uuid;
  v_created_tasks int := 0;
  v_created_plates int := 0;
  v_suggestion record;
  v_sug_rank int;
  v_task_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT id, organization_id, business_id, branch_id, warehouse_id
    INTO v_gr
  FROM public.goods_receipts
  WHERE id = p_goods_receipt_id;

  IF v_gr.id IS NULL THEN
    RAISE EXCEPTION 'goods_receipt % not found', p_goods_receipt_id;
  END IF;

  IF NOT user_can_access_business(auth.uid(), v_gr.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  -- Validate staging bin belongs to the same warehouse
  PERFORM 1 FROM public.stock_locations
   WHERE id = p_staging_location_id
     AND warehouse_id = v_gr.warehouse_id
     AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staging location % not in warehouse %', p_staging_location_id, v_gr.warehouse_id;
  END IF;

  FOR v_line IN
    SELECT gri.id AS line_id, gri.product_id, gri.quantity_received, gri.lot_number
    FROM public.goods_receipt_items gri
    WHERE gri.goods_receipt_id = p_goods_receipt_id
      AND COALESCE(gri.quantity_received, 0) > 0
      -- idempotency: skip if a putaway task already exists for this line
      AND NOT EXISTS (
        SELECT 1 FROM public.wms_tasks t
        WHERE t.task_type = 'putaway'
          AND (t.metadata->>'goods_receipt_item_id')::uuid = gri.id
      )
  LOOP
    -- Mint LPN
    v_lpn_code := 'LPN-' || to_char(now(), 'YY') || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    INSERT INTO public.wms_license_plates (
      organization_id, business_id, branch_id, warehouse_id,
      code, lpn_type, status, current_location_id, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      v_lpn_code, 'pallet', 'open', p_staging_location_id, auth.uid()
    )
    RETURNING id INTO v_lpn_id;
    v_created_plates := v_created_plates + 1;

    -- Attach stock to plate at staging (upsert-ish)
    INSERT INTO public.stock_quants (
      organization_id, business_id, branch_id,
      product_id, location_id, lot_number, package_id, quantity
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
      v_line.product_id, p_staging_location_id, v_line.lot_number, v_lpn_id, v_line.quantity_received
    );

    -- Suggest destinations
    v_dest_id := NULL;
    v_sug_rank := 0;

    INSERT INTO public.wms_tasks (
      organization_id, business_id, branch_id, warehouse_id,
      task_type, state, priority,
      source_doc_type, source_doc_id,
      source_location_id, destination_location_id,
      product_id, lot_number, lpn_id, quantity,
      metadata, created_by
    ) VALUES (
      v_gr.organization_id, v_gr.business_id, v_gr.branch_id, v_gr.warehouse_id,
      'putaway', 'pending', 100,
      'goods_receipt', p_goods_receipt_id,
      p_staging_location_id, NULL,
      v_line.product_id, v_line.lot_number, v_lpn_id, v_line.quantity_received,
      jsonb_build_object('goods_receipt_item_id', v_line.line_id),
      auth.uid()
    )
    RETURNING id INTO v_task_id;
    v_created_tasks := v_created_tasks + 1;
    v_task_ids := v_task_ids || v_task_id;

    FOR v_suggestion IN
      SELECT * FROM public.suggest_putaway_locations(v_gr.warehouse_id, v_line.product_id, v_line.quantity_received)
      LIMIT 3
    LOOP
      v_sug_rank := v_sug_rank + 1;
      INSERT INTO public.wms_putaway_suggestions (
        organization_id, business_id, branch_id,
        task_id, location_id, rank, reason, chosen
      ) VALUES (
        v_gr.organization_id, v_gr.business_id, v_gr.branch_id,
        v_task_id, v_suggestion.location_id, v_sug_rank, v_suggestion.reason,
        v_sug_rank = 1
      );
      IF v_sug_rank = 1 THEN
        v_dest_id := v_suggestion.location_id;
      END IF;
    END LOOP;

    IF v_dest_id IS NOT NULL THEN
      UPDATE public.wms_tasks
         SET destination_location_id = v_dest_id
       WHERE id = v_task_id;
    END IF;
  END LOOP;

  -- Outbox event (log-only pipe)
  BEGIN
    INSERT INTO public.business_event_outbox (
      organization_id, business_id, event_type, payload, idempotency_key, status
    ) VALUES (
      v_gr.organization_id, v_gr.business_id,
      'warehouse.receipt.staged',
      jsonb_build_object(
        'goods_receipt_id', p_goods_receipt_id,
        'staging_location_id', p_staging_location_id,
        'lpns_created', v_created_plates,
        'tasks_created', v_created_tasks,
        'task_ids', to_jsonb(v_task_ids)
      ),
      'wms.receipt.staged:' || p_goods_receipt_id::text || ':' || v_created_tasks::text,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'goods_receipt_id', p_goods_receipt_id,
    'lpns_created', v_created_plates,
    'tasks_created', v_created_tasks,
    'task_ids', to_jsonb(v_task_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.receive_goods_to_wms(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_goods_to_wms(uuid, uuid) TO authenticated, service_role;

-- 6) complete_putaway_task
CREATE OR REPLACE FUNCTION public.complete_putaway_task(p_task_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task record;
BEGIN
  SELECT * INTO v_task FROM public.wms_tasks WHERE id = p_task_id;
  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'task % not found', p_task_id;
  END IF;
  IF NOT user_can_access_business(auth.uid(), v_task.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_task.task_type <> 'putaway' THEN
    RAISE EXCEPTION 'task is not putaway';
  END IF;
  IF v_task.state NOT IN ('assigned','in_progress','pending') THEN
    RAISE EXCEPTION 'task in state % cannot be completed', v_task.state;
  END IF;
  IF v_task.destination_location_id IS NULL THEN
    RAISE EXCEPTION 'task has no destination';
  END IF;
  IF v_task.lpn_id IS NULL THEN
    RAISE EXCEPTION 'task has no LPN';
  END IF;

  PERFORM public.move_lpn(v_task.lpn_id, v_task.destination_location_id, 'putaway task ' || p_task_id::text);

  UPDATE public.wms_tasks
     SET state = 'done',
         completed_at = now(),
         started_at = COALESCE(started_at, now()),
         assignee_user_id = COALESCE(assignee_user_id, auth.uid())
   WHERE id = p_task_id;

  BEGIN
    INSERT INTO public.business_event_outbox (
      organization_id, business_id, event_type, payload, idempotency_key, status
    ) VALUES (
      v_task.organization_id, v_task.business_id,
      'warehouse.putaway.completed',
      jsonb_build_object(
        'task_id', p_task_id,
        'lpn_id', v_task.lpn_id,
        'destination_location_id', v_task.destination_location_id
      ),
      'wms.putaway.completed:' || p_task_id::text,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms putaway outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('task_id', p_task_id, 'state', 'done');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_putaway_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_putaway_task(uuid) TO authenticated, service_role;
