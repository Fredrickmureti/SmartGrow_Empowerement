-- =====================================================================
-- Phase 1 — Unify the cycle-count ledger path.
-- Inventory `physical_counts` becomes the canonical count document;
-- `wms_count_sessions` is demoted to the execution layer that feeds it.
-- =====================================================================

-- 1. Link column -------------------------------------------------------
ALTER TABLE public.wms_count_sessions
  ADD COLUMN IF NOT EXISTS physical_count_id uuid NULL
    REFERENCES public.physical_counts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_count_sessions_physical_count
  ON public.wms_count_sessions(physical_count_id)
  WHERE physical_count_id IS NOT NULL;

-- 2. Scoped freeze -----------------------------------------------------
-- Single implementation of "snapshot the count document". Optional
-- product filter + optional explicit quantity seed so a partial (cycle)
-- count snapshots only the bins it actually covers.
CREATE OR REPLACE FUNCTION public.physical_count_freeze_scoped(
  p_count_id uuid,
  p_user_id uuid,
  p_product_ids uuid[] DEFAULT NULL,
  p_line_seed jsonb DEFAULT NULL   -- [{product_id, system_qty}]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_lines int := 0; v_reservations int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'draft' THEN
    RAISE EXCEPTION 'cannot freeze count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.physical_count_lines (
    count_id, organization_id, business_id, product_id, system_qty_at_freeze,
    unit_cost_snapshot, cost_source
  )
  SELECT p_count_id, v_c.organization_id, v_c.business_id, p.id,
         COALESCE(seed.system_qty, ws.quantity, 0),
         COALESCE(ws.average_cost, p.cost_price, 0),
         'wac'
    FROM public.products p
    LEFT JOIN public.warehouse_stock ws
      ON ws.product_id = p.id AND ws.warehouse_id = v_c.warehouse_id
    LEFT JOIN LATERAL (
      SELECT (e->>'system_qty')::numeric AS system_qty
        FROM jsonb_array_elements(COALESCE(p_line_seed, '[]'::jsonb)) e
       WHERE (e->>'product_id')::uuid = p.id
       LIMIT 1
    ) seed ON true
   WHERE p.organization_id = v_c.organization_id
     AND p.business_id = v_c.business_id
     AND p.track_inventory = true
     AND p.type = 'product'
     AND (p_product_ids IS NULL OR p.id = ANY(p_product_ids))
  ON CONFLICT (count_id, product_id, packaging_id, lot_id) DO NOTHING;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  INSERT INTO public.physical_count_freeze_movements (
    count_id, organization_id, warehouse_id, product_id, last_movement_id
  )
  SELECT p_count_id, v_c.organization_id, v_c.warehouse_id, pcl.product_id,
         (SELECT id FROM public.stock_movements sm
           WHERE sm.warehouse_id = v_c.warehouse_id
             AND sm.product_id = pcl.product_id
           ORDER BY sm.created_at DESC LIMIT 1)
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
  ON CONFLICT (count_id, warehouse_id, product_id) DO NOTHING;

  INSERT INTO public.stock_reservations (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, quantity, source_type, source_id, reserved_by, expires_at
  )
  SELECT v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
         pcl.product_id, pcl.system_qty_at_freeze,
         'physical_count', p_count_id, p_user_id,
         now() + interval '24 hours'
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
     AND pcl.system_qty_at_freeze > 0;
  GET DIAGNOSTICS v_reservations = ROW_COUNT;

  UPDATE public.physical_counts
     SET state = 'counting', frozen_at = now(), frozen_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'frozen', p_user_id,
          jsonb_build_object(
            'lines_snapshotted', v_lines,
            'reservations_created', v_reservations,
            'scoped', p_product_ids IS NOT NULL
          ));

  RETURN jsonb_build_object('success', true, 'lines_snapshotted', v_lines, 'reservations_created', v_reservations);
END $$;

GRANT EXECUTE ON FUNCTION public.physical_count_freeze_scoped(uuid, uuid, uuid[], jsonb)
  TO authenticated, service_role;

-- Legacy full freeze delegates into the single implementation.
CREATE OR REPLACE FUNCTION public.physical_count_freeze(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN public.physical_count_freeze_scoped(p_count_id, p_user_id, NULL, NULL);
END $$;

-- 3. create_count_session — open the Inventory document alongside ------
CREATE OR REPLACE FUNCTION public.create_count_session(
  p_warehouse_id uuid,
  p_strategy text DEFAULT 'targeted',
  p_location_ids uuid[] DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wh record;
  v_session_id uuid;
  v_code text;
  v_pc_id uuid;
  v_products uuid[];
  v_seed jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_wh.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  v_code := 'CC-' || to_char(now(), 'YYMMDD-HH24MISS');

  INSERT INTO public.wms_count_sessions (
    organization_id, business_id, branch_id, warehouse_id,
    code, strategy, state, notes, created_by
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    v_code, p_strategy::public.wms_count_strategy, 'counting', p_notes, auth.uid()
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id,
    location_id, product_id, lot_number, system_qty
  )
  SELECT
    v_session_id, v_wh.organization_id, v_wh.business_id,
    q.location_id, q.product_id, q.lot_number, COALESCE(q.quantity, 0)
    FROM public.stock_quants q
    JOIN public.stock_locations sl ON sl.id = q.location_id
   WHERE sl.warehouse_id = p_warehouse_id
     AND q.business_id = v_wh.business_id
     AND (p_location_ids IS NULL OR q.location_id = ANY(p_location_ids));

  -- Canonical count document (Inventory owns tolerance / approval / GL).
  SELECT array_agg(DISTINCT product_id),
         jsonb_agg(jsonb_build_object('product_id', product_id, 'system_qty', sys))
    INTO v_products, v_seed
    FROM (
      SELECT product_id, SUM(system_qty) AS sys
        FROM public.wms_count_lines
       WHERE session_id = v_session_id
       GROUP BY product_id
    ) agg;

  IF v_products IS NOT NULL THEN
    v_pc_id := public.physical_count_create(
      v_wh.organization_id, v_wh.business_id, p_warehouse_id, auth.uid(),
      'cycle',
      jsonb_build_object(
        'source', 'wms_count_session',
        'session_id', v_session_id,
        'session_code', v_code,
        'strategy', p_strategy,
        'location_ids', to_jsonb(COALESCE(p_location_ids, ARRAY[]::uuid[]))
      ),
      NULL, NULL
    );

    PERFORM public.physical_count_freeze_scoped(v_pc_id, auth.uid(), v_products, v_seed);

    UPDATE public.wms_count_sessions
       SET physical_count_id = v_pc_id
     WHERE id = v_session_id;
  END IF;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wh.organization_id, v_wh.branch_id, p_warehouse_id,
      'warehouse.count.opened',
      'wms_count_session', v_session_id,
      jsonb_build_object(
        'session_id', v_session_id,
        'business_id', v_wh.business_id,
        'warehouse_id', p_warehouse_id,
        'strategy', p_strategy,
        'code', v_code,
        'physical_count_id', v_pc_id
      ),
      'wms.count.opened:' || v_session_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count opened outbox emit failed: %', SQLERRM;
  END;

  RETURN v_session_id;
END; $$;

-- 4. post_count_session — hand off to Inventory, never adjust directly --
CREATE OR REPLACE FUNCTION public.post_count_session(
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_session record;
  v_row record;
  v_variance_count int := 0;
  v_submit jsonb;
BEGIN
  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_session.id IS NULL THEN RAISE EXCEPTION 'session % not found', p_session_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_session.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be submitted', v_session.state;
  END IF;
  IF v_session.physical_count_id IS NULL THEN
    RAISE EXCEPTION 'session % has no linked inventory count document — reopen the session',
      p_session_id USING ERRCODE='P0001';
  END IF;

  -- Roll the bin/lot-level capture up to the product-level count document.
  -- Uncounted lines carry their snapshot forward, so a partial count
  -- never fabricates a variance.
  FOR v_row IN
    SELECT product_id,
           SUM(COALESCE(counted_qty, system_qty)) AS counted,
           SUM(system_qty)                        AS system_qty
      FROM public.wms_count_lines
     WHERE session_id = p_session_id
     GROUP BY product_id
  LOOP
    PERFORM public.physical_count_record_line(
      v_session.physical_count_id, v_row.product_id, v_row.counted, auth.uid(),
      NULL, 'wms_count_session:' || p_session_id::text
    );
    IF v_row.counted <> v_row.system_qty THEN
      v_variance_count := v_variance_count + 1;
    END IF;
  END LOOP;

  v_submit := public.physical_count_submit(v_session.physical_count_id, auth.uid());

  UPDATE public.wms_count_sessions
     SET state = 'review'
   WHERE id = p_session_id
     AND state <> 'review';

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
      'warehouse.count.submitted',
      'wms_count_session', p_session_id,
      jsonb_build_object(
        'session_id', p_session_id,
        'business_id', v_session.business_id,
        'physical_count_id', v_session.physical_count_id,
        'variance_count', v_variance_count
      ),
      'wms.count.submitted:' || p_session_id::text,
      'pending', auth.uid()
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count submitted outbox emit failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'physical_count_id', v_session.physical_count_id,
    'variance_count', v_variance_count,
    'submit_result', v_submit,
    'handoff', 'inventory_physical_count'
  );
END; $$;

-- 5. Mirror the Inventory terminal state back onto the session ---------
CREATE OR REPLACE FUNCTION public._wms_count_mirror_physical_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_session record;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('posted','cancelled') THEN
    SELECT * INTO v_session FROM public.wms_count_sessions WHERE physical_count_id = NEW.id;
    IF FOUND AND v_session.state NOT IN ('posted','cancelled') THEN
      UPDATE public.wms_count_sessions
         SET state = CASE WHEN NEW.state = 'posted' THEN 'posted'::public.wms_count_state
                          ELSE 'cancelled'::public.wms_count_state END,
             posted_at = CASE WHEN NEW.state = 'posted' THEN now() ELSE posted_at END,
             posted_by = CASE WHEN NEW.state = 'posted' THEN NEW.posted_by ELSE posted_by END
       WHERE id = v_session.id;

      BEGIN
        INSERT INTO public.business_event_outbox (
          org_id, branch_id, warehouse_id, event_type,
          source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
        ) VALUES (
          v_session.organization_id, v_session.branch_id, v_session.warehouse_id,
          CASE WHEN NEW.state = 'posted' THEN 'warehouse.count.posted'
               ELSE 'warehouse.count.cancelled' END,
          'wms_count_session', v_session.id,
          jsonb_build_object(
            'session_id', v_session.id,
            'business_id', v_session.business_id,
            'physical_count_id', NEW.id
          ),
          'wms.count.' || NEW.state || ':' || v_session.id::text,
          'pending', COALESCE(NEW.posted_by, NEW.cancelled_by)
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wms count mirror outbox emit failed: %', SQLERRM;
      END;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_count_mirror_physical_state ON public.physical_counts;
CREATE TRIGGER trg_wms_count_mirror_physical_state
  AFTER UPDATE OF state ON public.physical_counts
  FOR EACH ROW EXECUTE FUNCTION public._wms_count_mirror_physical_state();