
-- ===== Phase 1: recommendation lifecycle & work-item columns =====

-- 1) Extend procurement_recommendations
ALTER TABLE public.procurement_recommendations
  DROP CONSTRAINT IF EXISTS procurement_recommendations_status_check;

ALTER TABLE public.procurement_recommendations
  ADD COLUMN IF NOT EXISTS snooze_until timestamptz,
  ADD COLUMN IF NOT EXISTS assignee_id uuid,
  ADD COLUMN IF NOT EXISTS linked_po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_transfer_id uuid REFERENCES public.stock_transfers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_mo_id uuid,
  ADD COLUMN IF NOT EXISTS approval_request_id uuid,
  ADD COLUMN IF NOT EXISTS edited_qty numeric,
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES public.procurement_recommendations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS actioned_by uuid;

ALTER TABLE public.procurement_recommendations
  ADD CONSTRAINT procurement_recommendations_status_check
  CHECK (status IN (
    'open','snoozed','dismissed','actioned',
    'in_review','approved','executing','fulfilled','cancelled','merged'
  ));

CREATE INDEX IF NOT EXISTS idx_pr_linked_po ON public.procurement_recommendations(linked_po_id) WHERE linked_po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pr_linked_transfer ON public.procurement_recommendations(linked_transfer_id) WHERE linked_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pr_assignee ON public.procurement_recommendations(assignee_id) WHERE assignee_id IS NOT NULL;

-- 2) Audit table
CREATE TABLE IF NOT EXISTS public.procurement_recommendation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id uuid NOT NULL REFERENCES public.procurement_recommendations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid,
  event_type text NOT NULL CHECK (event_type IN (
    'created','status_changed','assigned','snoozed','edited_qty',
    'converted_po','converted_transfer','merged','comment','cancelled','fulfilled'
  )),
  from_status text,
  to_status text,
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.procurement_recommendation_events TO authenticated;
GRANT ALL ON public.procurement_recommendation_events TO service_role;

ALTER TABLE public.procurement_recommendation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pre_select ON public.procurement_recommendation_events;
CREATE POLICY pre_select ON public.procurement_recommendation_events
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS pre_insert ON public.procurement_recommendation_events;
CREATE POLICY pre_insert ON public.procurement_recommendation_events
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_pre_rec ON public.procurement_recommendation_events(recommendation_id, created_at DESC);

-- 3) Helper: record an event
CREATE OR REPLACE FUNCTION public.log_procurement_recommendation_event(
  p_rec_id uuid,
  p_event_type text,
  p_from_status text,
  p_to_status text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_org uuid;
  v_biz uuid;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_biz
  FROM public.procurement_recommendations WHERE id = p_rec_id;

  INSERT INTO public.procurement_recommendation_events(
    recommendation_id, organization_id, business_id, event_type,
    from_status, to_status, actor_id, payload, note
  ) VALUES (
    p_rec_id, v_org, v_biz, p_event_type,
    p_from_status, p_to_status, auth.uid(), COALESCE(p_payload,'{}'::jsonb), p_note
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 4) Snooze / dismiss / assign / edit-qty setters (write audit)
CREATE OR REPLACE FUNCTION public.snooze_procurement_recommendation(
  p_rec_id uuid,
  p_snooze_until timestamptz,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz uuid; v_from text;
BEGIN
  SELECT business_id, status INTO v_biz, v_from
  FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_biz IS NULL OR NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  UPDATE public.procurement_recommendations
  SET status = 'snoozed', snooze_until = p_snooze_until, updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'snoozed', v_from, 'snoozed',
    jsonb_build_object('snooze_until', p_snooze_until), p_note
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_procurement_recommendation(
  p_rec_id uuid,
  p_assignee uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_biz IS NULL OR NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  UPDATE public.procurement_recommendations
  SET assignee_id = p_assignee, updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'assigned', NULL, NULL,
    jsonb_build_object('assignee_id', p_assignee), NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_procurement_recommendation_qty(
  p_rec_id uuid,
  p_qty numeric,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_biz uuid; v_old numeric;
BEGIN
  SELECT business_id, suggested_qty INTO v_biz, v_old
  FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_biz IS NULL OR NOT public.user_can_access_business(auth.uid(), v_biz) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  IF p_qty IS NULL OR p_qty < 0 THEN
    RAISE EXCEPTION 'Quantity must be >= 0';
  END IF;

  UPDATE public.procurement_recommendations
  SET edited_qty = p_qty, override_reason = p_reason, updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'edited_qty', NULL, NULL,
    jsonb_build_object('old_qty', v_old, 'new_qty', p_qty), p_reason
  );
END;
$$;

-- 5) Convert to draft Purchase Order
CREATE OR REPLACE FUNCTION public.convert_recommendation_to_po(
  p_rec_id uuid,
  p_vendor_id uuid DEFAULT NULL,
  p_qty numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.procurement_recommendations%ROWTYPE;
  v_uid uuid := auth.uid();
  v_po_id uuid;
  v_po_no text;
  v_vendor uuid;
  v_qty numeric;
  v_unit_price numeric := 0;
  v_product_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_rec FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_rec.id IS NULL THEN RAISE EXCEPTION 'Recommendation not found'; END IF;

  IF NOT public.user_can_access_business(v_uid, v_rec.business_id) THEN
    RAISE EXCEPTION 'Access denied to business';
  END IF;
  IF v_rec.branch_id IS NOT NULL AND NOT public.can_access_branch(v_uid, v_rec.branch_id) THEN
    RAISE EXCEPTION 'Access denied to branch';
  END IF;
  IF v_rec.status IN ('fulfilled','cancelled','merged') THEN
    RAISE EXCEPTION 'Recommendation is % and cannot be converted', v_rec.status;
  END IF;
  IF v_rec.linked_po_id IS NOT NULL THEN
    RAISE EXCEPTION 'Recommendation already linked to purchase order %', v_rec.linked_po_id;
  END IF;

  v_vendor := COALESCE(p_vendor_id, v_rec.preferred_vendor_id);
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'A vendor is required (recommendation has no preferred vendor)';
  END IF;

  v_qty := COALESCE(p_qty, v_rec.edited_qty, v_rec.suggested_qty);
  IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  SELECT name, COALESCE(cost_price, 0) INTO v_product_name, v_unit_price
  FROM public.products WHERE id = v_rec.product_id;

  v_po_no := public.get_next_po_number(v_rec.organization_id);

  INSERT INTO public.purchase_orders(
    organization_id, business_id, branch_id, vendor_id,
    po_number, status, order_date, expected_date,
    subtotal, tax_amount, total, notes, created_by
  ) VALUES (
    v_rec.organization_id, v_rec.business_id, v_rec.branch_id, v_vendor,
    v_po_no, 'draft', CURRENT_DATE, v_rec.needed_by,
    v_qty * v_unit_price, 0, v_qty * v_unit_price,
    COALESCE(p_notes, 'Generated from replenishment recommendation'),
    v_uid
  ) RETURNING id INTO v_po_id;

  INSERT INTO public.purchase_order_items(
    purchase_order_id, product_id, description, quantity, unit_price, line_total
  ) VALUES (
    v_po_id, v_rec.product_id,
    COALESCE(v_product_name, 'Replenishment'),
    v_qty, v_unit_price, v_qty * v_unit_price
  );

  UPDATE public.procurement_recommendations
  SET status = 'executing',
      linked_po_id = v_po_id,
      actioned_at = now(),
      actioned_by = v_uid,
      actioned_ref_type = 'purchase_order',
      actioned_ref_id = v_po_id,
      updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'converted_po', v_rec.status, 'executing',
    jsonb_build_object('purchase_order_id', v_po_id, 'po_number', v_po_no,
                       'vendor_id', v_vendor, 'quantity', v_qty),
    p_notes
  );

  RETURN v_po_id;
END;
$$;

-- 6) Convert to draft Stock Transfer
CREATE OR REPLACE FUNCTION public.convert_recommendation_to_transfer(
  p_rec_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_qty numeric DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.procurement_recommendations%ROWTYPE;
  v_uid uuid := auth.uid();
  v_transfer_id uuid;
  v_transfer_no text;
  v_qty numeric;
  v_from_branch uuid;
  v_to_branch uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_from_warehouse_id IS NULL OR p_to_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'from/to warehouse required';
  END IF;
  IF p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'from and to warehouses must differ';
  END IF;

  SELECT * INTO v_rec FROM public.procurement_recommendations WHERE id = p_rec_id;
  IF v_rec.id IS NULL THEN RAISE EXCEPTION 'Recommendation not found'; END IF;
  IF NOT public.user_can_access_business(v_uid, v_rec.business_id) THEN
    RAISE EXCEPTION 'Access denied to business';
  END IF;
  IF v_rec.status IN ('fulfilled','cancelled','merged') THEN
    RAISE EXCEPTION 'Recommendation is % and cannot be converted', v_rec.status;
  END IF;
  IF v_rec.linked_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Recommendation already linked to transfer %', v_rec.linked_transfer_id;
  END IF;

  SELECT branch_id INTO v_from_branch FROM public.warehouses WHERE id = p_from_warehouse_id;
  SELECT branch_id INTO v_to_branch   FROM public.warehouses WHERE id = p_to_warehouse_id;

  IF v_from_branch IS NOT NULL AND NOT public.can_access_branch(v_uid, v_from_branch) THEN
    RAISE EXCEPTION 'Access denied to source branch';
  END IF;
  IF v_to_branch IS NOT NULL AND NOT public.can_access_branch(v_uid, v_to_branch) THEN
    RAISE EXCEPTION 'Access denied to destination branch';
  END IF;

  v_qty := COALESCE(p_qty, v_rec.edited_qty, v_rec.suggested_qty);
  IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be > 0'; END IF;

  v_transfer_no := public.get_next_transfer_number(v_rec.organization_id);

  INSERT INTO public.stock_transfers(
    organization_id, business_id, transfer_number,
    from_warehouse_id, to_warehouse_id,
    from_branch_id, to_branch_id,
    status, transfer_date, expected_arrival_date,
    notes, requested_by
  ) VALUES (
    v_rec.organization_id, v_rec.business_id, v_transfer_no,
    p_from_warehouse_id, p_to_warehouse_id,
    v_from_branch, v_to_branch,
    'draft', CURRENT_DATE, v_rec.needed_by,
    COALESCE(p_notes, 'Generated from replenishment recommendation'),
    v_uid
  ) RETURNING id INTO v_transfer_id;

  INSERT INTO public.stock_transfer_items(
    transfer_id, product_id, quantity_requested
  ) VALUES (v_transfer_id, v_rec.product_id, v_qty);

  UPDATE public.procurement_recommendations
  SET status = 'executing',
      linked_transfer_id = v_transfer_id,
      suggested_source = 'transfer',
      actioned_at = now(),
      actioned_by = v_uid,
      actioned_ref_type = 'stock_transfer',
      actioned_ref_id = v_transfer_id,
      updated_at = now()
  WHERE id = p_rec_id;

  PERFORM public.log_procurement_recommendation_event(
    p_rec_id, 'converted_transfer', v_rec.status, 'executing',
    jsonb_build_object('transfer_id', v_transfer_id, 'transfer_number', v_transfer_no,
                       'from_warehouse_id', p_from_warehouse_id,
                       'to_warehouse_id', p_to_warehouse_id, 'quantity', v_qty),
    p_notes
  );

  RETURN v_transfer_id;
END;
$$;

-- 7) Merge recommendations (same product + vendor)
CREATE OR REPLACE FUNCTION public.merge_procurement_recommendations(
  p_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_biz uuid;
  v_product uuid;
  v_vendor uuid;
  v_total_qty numeric := 0;
  v_target uuid;
  v_count int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) < 2 THEN
    RAISE EXCEPTION 'At least two recommendations required';
  END IF;

  SELECT COUNT(*), MIN(business_id), MIN(product_id), MIN(preferred_vendor_id),
         SUM(COALESCE(edited_qty, suggested_qty))
    INTO v_count, v_biz, v_product, v_vendor, v_total_qty
  FROM public.procurement_recommendations
  WHERE id = ANY(p_ids) AND status IN ('open','in_review','approved','snoozed');

  IF v_count IS DISTINCT FROM array_length(p_ids, 1) THEN
    RAISE EXCEPTION 'Some recommendations are missing or not mergeable';
  END IF;

  PERFORM 1 FROM public.procurement_recommendations
   WHERE id = ANY(p_ids)
     AND (business_id IS DISTINCT FROM v_biz
       OR product_id IS DISTINCT FROM v_product
       OR COALESCE(preferred_vendor_id, '00000000-0000-0000-0000-000000000000'::uuid)
          IS DISTINCT FROM COALESCE(v_vendor, '00000000-0000-0000-0000-000000000000'::uuid));
  IF FOUND THEN
    RAISE EXCEPTION 'Recommendations must share the same business, product and preferred vendor';
  END IF;

  IF NOT public.user_can_access_business(v_uid, v_biz) THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  -- Pick the most urgent as target
  SELECT id INTO v_target
  FROM public.procurement_recommendations
  WHERE id = ANY(p_ids)
  ORDER BY CASE urgency WHEN 'stockout' THEN 0 WHEN 'critical' THEN 1
                        WHEN 'low' THEN 2 ELSE 3 END, needed_by NULLS LAST
  LIMIT 1;

  UPDATE public.procurement_recommendations
  SET suggested_qty = v_total_qty, edited_qty = NULL, updated_at = now()
  WHERE id = v_target;

  UPDATE public.procurement_recommendations
  SET status = 'merged', merged_into_id = v_target, updated_at = now()
  WHERE id = ANY(p_ids) AND id <> v_target;

  PERFORM public.log_procurement_recommendation_event(
    v_target, 'merged', NULL, NULL,
    jsonb_build_object('merged_ids', to_jsonb(p_ids), 'total_qty', v_total_qty),
    NULL
  );

  RETURN v_target;
END;
$$;

-- 8) Auto-fulfill / cancel when linked PO / transfer changes state
CREATE OR REPLACE FUNCTION public.sync_recommendation_from_po()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('received','closed','completed') THEN
      UPDATE public.procurement_recommendations
      SET status = 'fulfilled', updated_at = now()
      WHERE linked_po_id = NEW.id AND status = 'executing';
    ELSIF NEW.status IN ('cancelled','rejected') THEN
      UPDATE public.procurement_recommendations
      SET status = 'open', linked_po_id = NULL,
          actioned_at = NULL, actioned_by = NULL,
          actioned_ref_type = NULL, actioned_ref_id = NULL,
          updated_at = now()
      WHERE linked_po_id = NEW.id AND status = 'executing';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_sync_recommendation ON public.purchase_orders;
CREATE TRIGGER trg_po_sync_recommendation
AFTER UPDATE ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.sync_recommendation_from_po();

CREATE OR REPLACE FUNCTION public.sync_recommendation_from_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('received','completed','closed') THEN
      UPDATE public.procurement_recommendations
      SET status = 'fulfilled', updated_at = now()
      WHERE linked_transfer_id = NEW.id AND status = 'executing';
    ELSIF NEW.status IN ('cancelled','rejected') THEN
      UPDATE public.procurement_recommendations
      SET status = 'open', linked_transfer_id = NULL,
          actioned_at = NULL, actioned_by = NULL,
          actioned_ref_type = NULL, actioned_ref_id = NULL,
          updated_at = now()
      WHERE linked_transfer_id = NEW.id AND status = 'executing';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transfer_sync_recommendation ON public.stock_transfers;
CREATE TRIGGER trg_transfer_sync_recommendation
AFTER UPDATE ON public.stock_transfers
FOR EACH ROW EXECUTE FUNCTION public.sync_recommendation_from_transfer();

-- 9) Grants for RPCs
GRANT EXECUTE ON FUNCTION public.log_procurement_recommendation_event(uuid, text, text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snooze_procurement_recommendation(uuid, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_procurement_recommendation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_procurement_recommendation_qty(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_recommendation_to_po(uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_recommendation_to_transfer(uuid, uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_procurement_recommendations(uuid[]) TO authenticated;
