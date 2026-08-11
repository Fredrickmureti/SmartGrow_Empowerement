-- Wave A.1 — update_po_items_atomic: authentication, business access, and a
-- status guard. Line items are the commercial substance of a PO; rewriting them
-- on a released order would silently mutate a supplier commitment.
CREATE OR REPLACE FUNCTION public.update_po_items_atomic(p_purchase_order_id uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  item JSONB;
  inserted_count INTEGER := 0;
  r public.purchase_orders;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO r FROM public.purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  IF NOT public.user_has_business_access(auth.uid(), r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF lower(coalesce(r.status::text, '')) NOT IN ('draft', 'revised', 'rejected') THEN
    RAISE EXCEPTION
      'Purchase order % is %; line items are editable only in draft/revised/rejected. Use revise_purchase_order to reopen it for editing.',
      r.po_number, r.status
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_purchase_order_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO purchase_order_items (
      purchase_order_id, product_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, received_quantity, sort_order,
      project_id, task_id
    ) VALUES (
      p_purchase_order_id,
      NULLIF(item->>'product_id', '')::UUID,
      COALESCE(item->>'description', ''),
      COALESCE((item->>'quantity')::NUMERIC, 0),
      COALESCE((item->>'unit_price')::NUMERIC, 0),
      COALESCE((item->>'tax_rate')::NUMERIC, 0),
      COALESCE((item->>'tax_amount')::NUMERIC, 0),
      COALESCE((item->>'line_total')::NUMERIC, 0),
      COALESCE((item->>'received_quantity')::NUMERIC, 0),
      COALESCE((item->>'sort_order')::INTEGER, 0),
      NULLIF(item->>'project_id', '')::UUID,
      NULLIF(item->>'task_id', '')::UUID
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$function$;

-- Wave A.2 — commercial-field immutability once a PO leaves the editable set.
-- Lifecycle/audit columns (status, *_by/*_at stamps, vendor_notes,
-- vendor_confirmed_at, converted_*, billing_status, is_sample_data) stay
-- writable so the lifecycle RPCs are unaffected.
CREATE OR REPLACE FUNCTION public._po_commercial_fields_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF lower(coalesce(OLD.status::text, '')) IN ('draft', 'revised', 'rejected') THEN
    RETURN NEW;
  END IF;

  IF NEW.vendor_id              IS DISTINCT FROM OLD.vendor_id
     OR NEW.po_number           IS DISTINCT FROM OLD.po_number
     OR NEW.currency            IS DISTINCT FROM OLD.currency
     OR NEW.order_date          IS DISTINCT FROM OLD.order_date
     OR NEW.expected_date       IS DISTINCT FROM OLD.expected_date
     OR NEW.subtotal            IS DISTINCT FROM OLD.subtotal
     OR NEW.tax_amount          IS DISTINCT FROM OLD.tax_amount
     OR NEW.discount_amount     IS DISTINCT FROM OLD.discount_amount
     OR NEW.total               IS DISTINCT FROM OLD.total
     OR NEW.shipping_address    IS DISTINCT FROM OLD.shipping_address
     OR NEW.notes               IS DISTINCT FROM OLD.notes
     OR NEW.project_id          IS DISTINCT FROM OLD.project_id
     OR NEW.deliver_to_warehouse_id IS DISTINCT FROM OLD.deliver_to_warehouse_id
     OR NEW.deliver_to_branch_id    IS DISTINCT FROM OLD.deliver_to_branch_id
     OR NEW.branch_id           IS DISTINCT FROM OLD.branch_id
     OR NEW.business_id         IS DISTINCT FROM OLD.business_id
     OR NEW.organization_id     IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION
      'Purchase order % is %; commercial terms are immutable outside draft/revised/rejected. Use revise_purchase_order to reopen it for editing.',
      OLD.po_number, OLD.status
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_po_commercial_fields_immutable ON public.purchase_orders;
CREATE TRIGGER trg_po_commercial_fields_immutable
  BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._po_commercial_fields_immutable();

-- Wave E (db half) — tidy _emit_po_outbox: drop the duplicated state segment and
-- make the key occurrence-aware via the row's updated_at, which every lifecycle
-- RPC stamps before emitting. A genuine second release (after revise) now
-- produces a fresh, auditable event; RPC-level idempotent replays return early
-- before emitting, so replay safety is unchanged.
CREATE OR REPLACE FUNCTION public._emit_po_outbox(_business_id uuid, _po_id uuid, _state text, _payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_updated timestamptz;
BEGIN
  SELECT organization_id, updated_at INTO v_org, v_updated
    FROM public.purchase_orders WHERE id = _po_id;
  INSERT INTO public.business_event_outbox
    (org_id, source, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (
    v_org, 'procurement', 'procurement.po.' || _state,
    'purchase_order', _po_id, _payload,
    'procurement.po:' || _po_id::text || ':' || _state || ':'
      || COALESCE(extract(epoch FROM v_updated)::bigint::text, '0'),
    'pending', auth.uid(), now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END $function$;

-- Wave B (db half) — the replenishment engine derives incoming supply from the
-- canonical inventory_expected_supply view instead of its own divergent item
-- query (which counted drafts and ignored approved/acknowledged orders).
CREATE OR REPLACE FUNCTION public.run_replenishment_planning(p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid, p_trigger_type text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_run_id uuid;
  v_created integer := 0;
  v_stockouts integer := 0;
  v_critical integer := 0;
  v_low integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_business_id IS NULL OR NOT public.user_can_access_business(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'Access denied to business %', p_business_id;
  END IF;

  IF p_branch_id IS NOT NULL AND NOT public.can_access_branch(v_uid, p_branch_id) THEN
    RAISE EXCEPTION 'Access denied to branch %', p_branch_id;
  END IF;

  IF p_trigger_type NOT IN ('manual','scheduled','event') THEN
    p_trigger_type := 'manual';
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Business not found';
  END IF;

  INSERT INTO public.replenishment_runs(
    organization_id, business_id, branch_id, run_type, triggered_by, status
  ) VALUES (
    v_org_id, p_business_id, p_branch_id, p_trigger_type, v_uid, 'running'
  ) RETURNING id INTO v_run_id;

  WITH rules AS (
    SELECT r.*
    FROM public.product_reorder_rules r
    WHERE r.business_id = p_business_id
      AND r.is_active = true
      AND (p_branch_id IS NULL OR r.branch_id IS NULL OR r.branch_id = p_branch_id)
  ),
  stock_agg AS (
    SELECT ws.product_id, ws.branch_id,
           COALESCE(SUM(ws.quantity), 0)::numeric AS on_hand,
           COALESCE(SUM(ws.reserved_quantity), 0)::numeric AS reserved
    FROM public.warehouse_stock ws
    WHERE ws.business_id = p_business_id
      AND (p_branch_id IS NULL OR ws.branch_id = p_branch_id)
    GROUP BY ws.product_id, ws.branch_id
  ),
  -- Canonical expected supply: committed POs only (approved/sent/acknowledged/
  -- partial_received), outstanding qty > 0, deliver-to branch preferred.
  incoming_agg AS (
    SELECT es.product_id, es.branch_id,
           COALESCE(SUM(es.expected_quantity), 0)::numeric AS incoming
    FROM public.inventory_expected_supply es
    WHERE es.business_id = p_business_id
      AND (p_branch_id IS NULL OR es.branch_id = p_branch_id)
    GROUP BY es.product_id, es.branch_id
  ),
  velocity_agg AS (
    SELECT sm.product_id, sm.branch_id,
           (COALESCE(SUM(CASE WHEN sm.quantity < 0 THEN -sm.quantity ELSE 0 END), 0) / 4.0)::numeric AS per_week
    FROM public.stock_movements sm
    WHERE sm.business_id = p_business_id
      AND sm.movement_date >= now() - interval '28 days'
      AND (p_branch_id IS NULL OR sm.branch_id = p_branch_id)
    GROUP BY sm.product_id, sm.branch_id
  ),
  calc AS (
    SELECT
      r.product_id,
      COALESCE(r.branch_id, s.branch_id) AS branch_id,
      COALESCE(s.on_hand, 0) AS on_hand,
      COALESCE(s.reserved, 0) AS reserved,
      COALESCE(i.incoming, 0) AS incoming,
      COALESCE(v.per_week, 0) AS velocity_per_week,
      COALESCE(r.safety_stock, 0) AS safety_stock,
      COALESCE(r.lead_time_days, 7) AS lead_time_days,
      COALESCE(r.moq, 0) AS moq,
      COALESCE(NULLIF(r.pack_size, 0), 1) AS pack_size,
      r.reorder_quantity,
      r.min_quantity AS reorder_point,
      r.preferred_supplier_id AS preferred_vendor_id
    FROM rules r
    LEFT JOIN stock_agg s
      ON s.product_id = r.product_id
     AND (r.branch_id IS NULL OR s.branch_id = r.branch_id)
    LEFT JOIN incoming_agg i
      ON i.product_id = r.product_id
     AND (r.branch_id IS NULL OR i.branch_id = r.branch_id)
    LEFT JOIN velocity_agg v
      ON v.product_id = r.product_id
     AND (r.branch_id IS NULL OR v.branch_id = r.branch_id)
  ),
  computed AS (
    SELECT
      c.*,
      GREATEST(0, c.on_hand - GREATEST(0, c.reserved)) AS available,
      (c.velocity_per_week / 7.0) * c.lead_time_days AS forecast_lead_demand
    FROM calc c
  ),
  final AS (
    SELECT
      cm.*,
      GREATEST(0, cm.safety_stock + cm.forecast_lead_demand - cm.available - cm.incoming) AS raw_need,
      CASE
        WHEN cm.available <= 0 THEN 'stockout'
        WHEN cm.velocity_per_week > 0
             AND (cm.available / NULLIF(cm.velocity_per_week / 7.0, 0)) < 7
          THEN 'critical'
        WHEN cm.velocity_per_week > 0
             AND (cm.available / NULLIF(cm.velocity_per_week / 7.0, 0)) < 14
          THEN 'low'
        ELSE 'planned'
      END AS urgency
    FROM computed cm
  )
  INSERT INTO public.procurement_recommendations(
    run_id, organization_id, business_id, branch_id, product_id,
    on_hand, reserved, incoming, velocity_per_week, safety_stock, lead_time_days,
    net_requirement, suggested_qty, suggested_source, preferred_vendor_id, urgency,
    needed_by, explanation, status
  )
  SELECT
    v_run_id, v_org_id, p_business_id, f.branch_id, f.product_id,
    f.on_hand, f.reserved, f.incoming, f.velocity_per_week, f.safety_stock, f.lead_time_days,
    f.raw_need,
    CASE
      WHEN f.raw_need <= 0 THEN 0
      ELSE GREATEST(f.moq, CEIL(f.raw_need / f.pack_size) * f.pack_size)
    END,
    'buy',
    f.preferred_vendor_id,
    f.urgency,
    (current_date + (f.lead_time_days || ' days')::interval)::date,
    jsonb_build_object(
      'on_hand', f.on_hand,
      'reserved', f.reserved,
      'available', f.available,
      'incoming', f.incoming,
      'velocity_per_week', f.velocity_per_week,
      'safety_stock', f.safety_stock,
      'lead_time_days', f.lead_time_days,
      'moq', f.moq,
      'pack_size', f.pack_size,
      'forecast_lead_demand', f.forecast_lead_demand,
      'reorder_point', f.reorder_point,
      'raw_need', f.raw_need
    ),
    'open'
  FROM final f
  WHERE f.raw_need > 0
     OR f.urgency IN ('stockout','critical');

  GET DIAGNOSTICS v_created = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE urgency = 'stockout'),
    COUNT(*) FILTER (WHERE urgency = 'critical'),
    COUNT(*) FILTER (WHERE urgency = 'low')
  INTO v_stockouts, v_critical, v_low
  FROM public.procurement_recommendations
  WHERE run_id = v_run_id;

  UPDATE public.replenishment_runs
  SET status = 'completed',
      completed_at = now(),
      recommendations_created = v_created,
      stockouts = COALESCE(v_stockouts, 0),
      critical = COALESCE(v_critical, 0),
      low = COALESCE(v_low, 0)
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'recommendations_created', v_created,
    'stockouts', COALESCE(v_stockouts, 0),
    'critical', COALESCE(v_critical, 0),
    'low', COALESCE(v_low, 0)
  );
END;
$function$;