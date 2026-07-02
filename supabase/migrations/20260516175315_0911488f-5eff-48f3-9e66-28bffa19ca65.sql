
-- =====================================================================
-- Phase D1 — Delivery Note logistics & lifecycle schema
-- =====================================================================

-- 1. Carriers registry --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.carriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name text NOT NULL,
  contact_phone text,
  contact_email text,
  tracking_url_template text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX IF NOT EXISTS idx_carriers_org_biz ON public.carriers(organization_id, business_id);
ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;

CREATE POLICY carriers_select_v1 ON public.carriers FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view'));
CREATE POLICY carriers_insert_v1 ON public.carriers FOR INSERT
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'));
CREATE POLICY carriers_update_v1 ON public.carriers FOR UPDATE
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'));
CREATE POLICY carriers_delete_v1 ON public.carriers FOR DELETE
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'));

-- 2. Extend delivery_notes ---------------------------------------------
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS shipping_method text,
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS dispatch_officer_id uuid,
  ADD COLUMN IF NOT EXISTS dispatch_route text,
  ADD COLUMN IF NOT EXISTS dispatch_instructions text,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS freight_cost numeric(14,2),
  ADD COLUMN IF NOT EXISTS freight_currency text,
  ADD COLUMN IF NOT EXISTS received_by_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backorder_of_dn_id uuid REFERENCES public.delivery_notes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_backorder boolean NOT NULL DEFAULT false;

-- shipping_method enum-like guard
ALTER TABLE public.delivery_notes DROP CONSTRAINT IF EXISTS delivery_notes_shipping_method_check;
ALTER TABLE public.delivery_notes ADD CONSTRAINT delivery_notes_shipping_method_check
  CHECK (shipping_method IS NULL OR shipping_method IN
    ('pickup','own_vehicle','courier','third_party_logistics','freight'));

-- Status: add ready_to_dispatch + dispatched
ALTER TABLE public.delivery_notes DROP CONSTRAINT IF EXISTS delivery_notes_status_check;
ALTER TABLE public.delivery_notes ADD CONSTRAINT delivery_notes_status_check
  CHECK (status IN ('pending','ready_to_dispatch','dispatched','in_transit','delivered','partial','cancelled'));

CREATE INDEX IF NOT EXISTS idx_delivery_notes_biz_status_date
  ON public.delivery_notes(business_id, status, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_notes_backorder_of
  ON public.delivery_notes(backorder_of_dn_id) WHERE backorder_of_dn_id IS NOT NULL;

-- 3. Delivery note events (timeline) -----------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_note_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  notes text,
  payload jsonb
);
CREATE INDEX IF NOT EXISTS idx_dn_events_dn ON public.delivery_note_events(delivery_note_id, occurred_at DESC);
ALTER TABLE public.delivery_note_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY dn_events_select_v1 ON public.delivery_note_events FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view'));
-- No INSERT/UPDATE/DELETE policies: only SECURITY DEFINER functions can write.

-- 4. Delivery proofs ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  signature_url text,
  photo_urls text[] DEFAULT ARRAY[]::text[],
  received_by_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  received_by_name text,
  received_at timestamptz NOT NULL DEFAULT now(),
  gps_lat numeric(10,7),
  gps_lng numeric(10,7),
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_proofs_dn ON public.delivery_proofs(delivery_note_id);
ALTER TABLE public.delivery_proofs ENABLE ROW LEVEL SECURITY;

CREATE POLICY delivery_proofs_select_v1 ON public.delivery_proofs FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'view'));
CREATE POLICY delivery_proofs_insert_v1 ON public.delivery_proofs FOR INSERT
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'sales', 'manage'));

-- 5. Storage bucket for proofs (private) -------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivery-proofs', 'delivery-proofs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "delivery-proofs read by org members" ON storage.objects;
CREATE POLICY "delivery-proofs read by org members" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'delivery-proofs'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "delivery-proofs write by org members" ON storage.objects;
CREATE POLICY "delivery-proofs write by org members" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'delivery-proofs'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "delivery-proofs delete by org members" ON storage.objects;
CREATE POLICY "delivery-proofs delete by org members" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'delivery-proofs'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id::text = (storage.foldername(name))[1]
    )
  );

-- =====================================================================
-- Phase D2 — Lifecycle RPCs
-- =====================================================================

-- Helper: log a DN event (internal)
CREATE OR REPLACE FUNCTION public._log_dn_event(
  _dn_id uuid, _event_type text, _actor uuid, _notes text DEFAULT NULL, _payload jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_org uuid; v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz FROM public.delivery_notes WHERE id = _dn_id;
  IF v_org IS NULL THEN RETURN; END IF;
  INSERT INTO public.delivery_note_events (delivery_note_id, organization_id, business_id, event_type, actor_id, notes, payload)
  VALUES (_dn_id, v_org, v_biz, _event_type, _actor, _notes, _payload);
END $$;

-- mark_delivery_ready_atomic
CREATE OR REPLACE FUNCTION public.mark_delivery_ready_atomic(p_dn_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_dn record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id, status INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_dn.status NOT IN ('pending') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only pending deliveries can be marked ready');
  END IF;
  UPDATE public.delivery_notes
     SET status = 'ready_to_dispatch', ready_at = now(), updated_at = now()
   WHERE id = p_dn_id;
  PERFORM public._log_dn_event(p_dn_id, 'ready_to_dispatch', p_user_id, NULL, NULL);
  RETURN jsonb_build_object('success', true);
END $$;

-- dispatch_delivery_atomic
CREATE OR REPLACE FUNCTION public.dispatch_delivery_atomic(
  p_dn_id uuid, p_user_id uuid, p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_dn record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id, status INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_dn.status NOT IN ('pending','ready_to_dispatch') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only pending or ready deliveries can be dispatched');
  END IF;
  -- Optional carrier business-match check
  IF (p_payload ? 'carrier_id') AND (p_payload->>'carrier_id') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.carriers c
      WHERE c.id = (p_payload->>'carrier_id')::uuid
        AND c.business_id = v_dn.business_id
    ) THEN
      RAISE EXCEPTION 'Carrier does not belong to this company';
    END IF;
  END IF;
  UPDATE public.delivery_notes SET
    status = 'dispatched',
    dispatched_at = now(),
    shipping_method = COALESCE(p_payload->>'shipping_method', shipping_method),
    carrier_id = COALESCE(NULLIF(p_payload->>'carrier_id','')::uuid, carrier_id),
    tracking_number = COALESCE(p_payload->>'tracking_number', tracking_number),
    dispatch_officer_id = COALESCE(NULLIF(p_payload->>'dispatch_officer_id','')::uuid, dispatch_officer_id),
    dispatch_route = COALESCE(p_payload->>'dispatch_route', dispatch_route),
    dispatch_instructions = COALESCE(p_payload->>'dispatch_instructions', dispatch_instructions),
    driver_name = COALESCE(p_payload->>'driver_name', driver_name),
    vehicle_number = COALESCE(p_payload->>'vehicle_number', vehicle_number),
    freight_cost = COALESCE((NULLIF(p_payload->>'freight_cost',''))::numeric, freight_cost),
    freight_currency = COALESCE(p_payload->>'freight_currency', freight_currency),
    updated_at = now()
   WHERE id = p_dn_id;
  PERFORM public._log_dn_event(p_dn_id, 'dispatched', p_user_id, NULL, p_payload);
  RETURN jsonb_build_object('success', true);
END $$;

-- update_delivery_logistics_atomic (no inventory side-effect)
CREATE OR REPLACE FUNCTION public.update_delivery_logistics_atomic(
  p_dn_id uuid, p_user_id uuid, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_dn record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF (p_payload ? 'carrier_id') AND NULLIF(p_payload->>'carrier_id','') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.carriers c
      WHERE c.id = (p_payload->>'carrier_id')::uuid AND c.business_id = v_dn.business_id
    ) THEN RAISE EXCEPTION 'Carrier does not belong to this company'; END IF;
  END IF;
  UPDATE public.delivery_notes SET
    shipping_method = COALESCE(p_payload->>'shipping_method', shipping_method),
    carrier_id = COALESCE(NULLIF(p_payload->>'carrier_id','')::uuid, carrier_id),
    tracking_number = COALESCE(p_payload->>'tracking_number', tracking_number),
    dispatch_officer_id = COALESCE(NULLIF(p_payload->>'dispatch_officer_id','')::uuid, dispatch_officer_id),
    dispatch_route = COALESCE(p_payload->>'dispatch_route', dispatch_route),
    dispatch_instructions = COALESCE(p_payload->>'dispatch_instructions', dispatch_instructions),
    driver_name = COALESCE(p_payload->>'driver_name', driver_name),
    vehicle_number = COALESCE(p_payload->>'vehicle_number', vehicle_number),
    freight_cost = COALESCE(NULLIF(p_payload->>'freight_cost','')::numeric, freight_cost),
    freight_currency = COALESCE(p_payload->>'freight_currency', freight_currency),
    shipping_address = COALESCE(p_payload->>'shipping_address', shipping_address),
    notes = COALESCE(p_payload->>'notes', notes),
    updated_at = now()
   WHERE id = p_dn_id;
  PERFORM public._log_dn_event(p_dn_id, 'logistics_updated', p_user_id, NULL, p_payload);
  RETURN jsonb_build_object('success', true);
END $$;

-- Re-create complete_delivery_atomic with POD support + lifecycle entry
DROP FUNCTION IF EXISTS public.complete_delivery_atomic(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.complete_delivery_atomic(uuid, uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.complete_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_received_by text DEFAULT NULL,
  p_pod jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dn record;
  v_so_branch_id uuid;
  v_warehouse_id uuid;
  v_branch_id uuid;
  v_org_id uuid;
  v_biz_id uuid;
  v_item record;
  v_unit_cost numeric;
  v_line_cost numeric;
  v_total_cogs numeric := 0;
  v_inventory_acct uuid;
  v_cogs_acct uuid;
  v_journal_id uuid;
  v_entry_no text;
  v_movement_count int := 0;
  v_so_id uuid;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_cogs_lines jsonb;
  v_currency text;
  v_pod_id uuid;
  v_is_partial boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;

  SELECT id, organization_id, business_id, branch_id, sales_order_id, delivery_number, status
    INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Delivery note not found'); END IF;

  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  v_org_id := v_dn.organization_id;
  v_biz_id := v_dn.business_id;
  v_so_id := v_dn.sales_order_id;

  IF v_biz_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_biz_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_biz_id USING ERRCODE='42501';
  END IF;

  SELECT id, branch_id INTO v_warehouse_id, v_branch_id
    FROM public.warehouses
   WHERE organization_id = v_org_id AND business_id = v_biz_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_dn.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST, created_at ASC LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No active warehouse found for this branch — create one before delivering.');
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT branch_id INTO v_so_branch_id FROM public.sales_orders WHERE id = v_so_id;
    IF v_so_branch_id IS NOT NULL AND v_branch_id IS NOT NULL AND v_so_branch_id <> v_branch_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sales order is in a different branch than the warehouse.');
    END IF;
  END IF;

  FOR v_item IN
    SELECT dni.id, dni.product_id, dni.description, dni.quantity_ordered, dni.quantity_delivered,
           dni.sales_order_item_id, p.cost_price, p.track_inventory
      FROM public.delivery_note_items dni
 LEFT JOIN public.products p ON p.id = dni.product_id
     WHERE dni.delivery_note_id = p_dn_id AND dni.quantity_delivered > 0
  LOOP
    IF v_item.quantity_delivered < v_item.quantity_ordered THEN
      v_is_partial := true;
    END IF;
    IF v_item.sales_order_item_id IS NOT NULL THEN
      UPDATE public.sales_order_items
         SET quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + v_item.quantity_delivered
       WHERE id = v_item.sales_order_item_id;
    END IF;
    IF v_item.product_id IS NULL OR NOT COALESCE(v_item.track_inventory, true) THEN CONTINUE; END IF;

    v_unit_cost := COALESCE(v_item.cost_price, 0);
    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_branch_id, v_warehouse_id,
      v_item.product_id, 'delivery', -ABS(v_item.quantity_delivered), v_unit_cost,
      'delivery_note', p_dn_id,
      'Delivery ' || v_dn.delivery_number || COALESCE(' — ' || v_item.description, ''),
      p_user_id
    );
    v_movement_count := v_movement_count + 1;
    v_line_cost := ABS(v_item.quantity_delivered) * v_unit_cost;
    v_total_cogs := v_total_cogs + v_line_cost;
  END LOOP;

  IF v_total_cogs > 0 THEN
    SELECT COALESCE(base_currency, 'USD') INTO v_currency FROM public.businesses WHERE id = v_biz_id;
    SELECT id INTO v_inventory_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'inventory' AND is_active = true LIMIT 1;
    SELECT id INTO v_cogs_acct FROM public.accounts
     WHERE organization_id = v_org_id AND business_id = v_biz_id
       AND detail_type = 'cost_of_goods_sold' AND is_active = true LIMIT 1;

    IF v_inventory_acct IS NOT NULL AND v_cogs_acct IS NOT NULL THEN
      SELECT public.get_next_journal_entry_number(v_org_id) INTO v_entry_no;
      v_cogs_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs_acct, 'debit', v_total_cogs, 'credit', 0, 'description', 'COGS - ' || v_dn.delivery_number),
        jsonb_build_object('account_id', v_inventory_acct, 'debit', 0, 'credit', v_total_cogs, 'description', 'Inventory reduction - ' || v_dn.delivery_number)
      );
      v_journal_id := public.post_journal_entry_atomic(
        _org_id := v_org_id, _business_id := v_biz_id,
        _entry_number := v_entry_no, _entry_date := CURRENT_DATE,
        _reference := 'COGS-' || v_dn.delivery_number,
        _description := 'COGS for delivery ' || v_dn.delivery_number,
        _source_type := 'delivery_note', _source_id := p_dn_id,
        _created_by := p_user_id, _is_closing := false, _is_adjusting := false,
        _lines := v_cogs_lines, _currency := v_currency, _exchange_rate := NULL,
        _source_subtype := 'cogs', _branch_id := v_branch_id
      );
    END IF;
  END IF;

  UPDATE public.delivery_notes
     SET status = CASE WHEN v_is_partial THEN 'partial' ELSE 'delivered' END,
         delivered_at = now(),
         received_by = COALESCE(p_received_by, received_by),
         updated_at = now()
   WHERE id = p_dn_id;

  -- Proof of delivery (optional)
  IF p_pod IS NOT NULL AND p_pod <> '{}'::jsonb THEN
    INSERT INTO public.delivery_proofs (
      delivery_note_id, organization_id, business_id,
      signature_url, photo_urls, received_by_contact_id, received_by_name,
      received_at, gps_lat, gps_lng, notes, created_by
    ) VALUES (
      p_dn_id, v_org_id, v_biz_id,
      p_pod->>'signature_url',
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_pod->'photo_urls')), ARRAY[]::text[]),
      NULLIF(p_pod->>'received_by_contact_id','')::uuid,
      COALESCE(p_pod->>'received_by_name', p_received_by),
      COALESCE(NULLIF(p_pod->>'received_at','')::timestamptz, now()),
      NULLIF(p_pod->>'gps_lat','')::numeric,
      NULLIF(p_pod->>'gps_lng','')::numeric,
      p_pod->>'notes',
      p_user_id
    ) RETURNING id INTO v_pod_id;
  END IF;

  IF v_so_id IS NOT NULL THEN
    SELECT bool_and(quantity_fulfilled >= quantity), bool_or(quantity_fulfilled > 0)
      INTO v_all_fulfilled, v_any_fulfilled
      FROM public.sales_order_items WHERE sales_order_id = v_so_id;
    IF v_all_fulfilled THEN
      UPDATE public.sales_orders SET status = 'fulfilled', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled');
    ELSIF v_any_fulfilled THEN
      UPDATE public.sales_orders SET status = 'partial', updated_at = now()
       WHERE id = v_so_id AND status NOT IN ('invoiced','cancelled','fulfilled');
    END IF;
  END IF;

  PERFORM public._log_dn_event(p_dn_id, CASE WHEN v_is_partial THEN 'partially_delivered' ELSE 'delivered' END,
    p_user_id, p_received_by,
    jsonb_build_object('movements', v_movement_count, 'cogs', v_total_cogs, 'pod_id', v_pod_id));

  RETURN jsonb_build_object(
    'success', true, 'delivery_id', p_dn_id, 'warehouse_id', v_warehouse_id,
    'movements_created', v_movement_count, 'gl_posted', v_journal_id IS NOT NULL,
    'cogs_total', v_total_cogs, 'pod_id', v_pod_id, 'partial', v_is_partial
  );
END $$;

-- record_partial_delivery_atomic: set per-line delivered qty, complete, optionally backorder
CREATE OR REPLACE FUNCTION public.record_partial_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_line_qtys jsonb,                  -- [{"item_id":"...","quantity_delivered":N}, ...]
  p_create_backorder boolean DEFAULT true,
  p_received_by text DEFAULT NULL,
  p_pod jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dn record;
  v_line jsonb;
  v_backorder_id uuid;
  v_complete jsonb;
  v_remaining_count int := 0;
  v_new_number text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_dn FROM public.delivery_notes WHERE id = p_dn_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Not found'); END IF;
  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_dn.status IN ('delivered','partial','cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery already finalised');
  END IF;

  -- Apply per-line delivered quantities
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_line_qtys, '[]'::jsonb))
  LOOP
    UPDATE public.delivery_note_items
       SET quantity_delivered = LEAST(
             GREATEST((v_line->>'quantity_delivered')::numeric, 0),
             quantity_ordered
           )
     WHERE id = (v_line->>'item_id')::uuid AND delivery_note_id = p_dn_id;
  END LOOP;

  -- Complete with whatever quantities are now on the lines
  v_complete := public.complete_delivery_atomic(p_dn_id, p_user_id, p_received_by, p_pod);
  IF NOT COALESCE((v_complete->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Complete failed: %', v_complete->>'error';
  END IF;

  -- Build backorder for remaining quantities
  IF p_create_backorder THEN
    SELECT COUNT(*) INTO v_remaining_count
      FROM public.delivery_note_items
     WHERE delivery_note_id = p_dn_id AND quantity_ordered > quantity_delivered;

    IF v_remaining_count > 0 THEN
      SELECT public.get_next_delivery_number(v_dn.organization_id) INTO v_new_number;
      INSERT INTO public.delivery_notes (
        organization_id, business_id, branch_id, contact_id, delivery_number,
        delivery_date, status, sales_order_id, shipping_address, notes,
        is_backorder, backorder_of_dn_id, created_by
      ) VALUES (
        v_dn.organization_id, v_dn.business_id, v_dn.branch_id, v_dn.contact_id, v_new_number,
        CURRENT_DATE, 'pending', v_dn.sales_order_id, v_dn.shipping_address,
        'Backorder of ' || v_dn.delivery_number,
        true, p_dn_id, p_user_id
      ) RETURNING id INTO v_backorder_id;

      INSERT INTO public.delivery_note_items (
        delivery_note_id, product_id, sales_order_item_id, description,
        quantity_ordered, quantity_delivered, sort_order
      )
      SELECT v_backorder_id, product_id, sales_order_item_id, description,
             (quantity_ordered - quantity_delivered), (quantity_ordered - quantity_delivered),
             sort_order
        FROM public.delivery_note_items
       WHERE delivery_note_id = p_dn_id AND quantity_ordered > quantity_delivered;

      PERFORM public._log_dn_event(p_dn_id, 'backorder_created', p_user_id, NULL,
        jsonb_build_object('backorder_id', v_backorder_id, 'backorder_number', v_new_number));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'complete_result', v_complete,
    'backorder_id', v_backorder_id
  );
END $$;
