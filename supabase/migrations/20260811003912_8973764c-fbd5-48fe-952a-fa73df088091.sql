-- =====================================================================
-- Purchase Order domain convergence (Stages 1-4 of the PO audit plan)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Caller-side idempotency for PO approval
-- ---------------------------------------------------------------------
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS approval_client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_org_approval_request_uq
  ON public.purchase_orders (organization_id, approval_client_request_id)
  WHERE approval_client_request_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.approve_purchase_order(uuid);

CREATE OR REPLACE FUNCTION public.approve_purchase_order(
  p_po_id uuid,
  p_client_request_id text DEFAULT NULL
)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;

  SELECT * INTO r FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;

  -- Idempotent replay: same intent key on an already-approved PO returns it.
  IF p_client_request_id IS NOT NULL
     AND r.approval_client_request_id IS NOT DISTINCT FROM p_client_request_id
     AND lower(coalesce(r.status::text,'')) = 'approved' THEN
    RETURN r;
  END IF;

  IF lower(coalesce(r.status::text,'')) NOT IN ('draft','submitted') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;

  PERFORM public.governance_assert_not_self(
    v_uid, COALESCE(r.submitted_by, r.created_by),
    'purchase_order.approve', r.organization_id, 'purchase_order', r.id);

  UPDATE public.purchase_orders
     SET status = 'approved',
         approved_by = v_uid,
         approved_at = now(),
         approval_client_request_id = COALESCE(p_client_request_id, approval_client_request_id),
         updated_at = now()
   WHERE id = p_po_id
   RETURNING * INTO r;

  PERFORM public._emit_po_outbox(r.business_id, r.id, 'approved',
    jsonb_build_object('po_number', r.po_number, 'approved_by', v_uid, 'total', r.total));

  RETURN r;
END $function$;

-- ---------------------------------------------------------------------
-- 2. Domain-owned consumers of procurement.po.* events
--    (same shape as wms_apply_gr_stock / finance_post_gr_journal)
-- ---------------------------------------------------------------------

-- Warehouse: an approved+released PO means goods are expected to arrive.
CREATE OR REPLACE FUNCTION public.wms_po_ensure_expected_inbound(
  _event_id uuid,
  _po_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r public.purchase_orders;
BEGIN
  SELECT * INTO r FROM public.purchase_orders WHERE id = _po_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Idempotent: one open expected inbound per PO.
  IF EXISTS (
    SELECT 1 FROM public.inbound_shipments
     WHERE purchase_order_id = _po_id
       AND status <> 'cancelled'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.inbound_shipments (
    organization_id, business_id, branch_id, purchase_order_id, vendor_id,
    shipment_number, status, expected_arrival_at, warehouse_id, notes, created_by
  ) VALUES (
    r.organization_id, r.business_id,
    COALESCE(r.deliver_to_branch_id, r.branch_id), r.id, r.vendor_id,
    'ASN-' || r.po_number, 'draft',
    CASE WHEN r.expected_date IS NOT NULL THEN r.expected_date::timestamptz ELSE NULL END,
    r.deliver_to_warehouse_id,
    'Auto-created from released purchase order ' || r.po_number,
    r.approved_by
  );
END $function$;

-- Warehouse: cancellation / revision withdraws the expectation.
CREATE OR REPLACE FUNCTION public.wms_po_withdraw_expected_inbound(
  _event_id uuid,
  _po_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.inbound_shipments
     SET status = 'cancelled', updated_at = now()
   WHERE purchase_order_id = _po_id
     AND status IN ('draft', 'dispatched', 'in_transit');
END $function$;

-- Notifications: ask for a supplier email; never send inside the transaction.
CREATE OR REPLACE FUNCTION public.notify_po_supplier_release(
  _event_id uuid,
  _po_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r public.purchase_orders; v_email text; v_name text;
BEGIN
  SELECT * INTO r FROM public.purchase_orders WHERE id = _po_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT c.email, c.name INTO v_email, v_name
    FROM public.contacts c WHERE c.id = r.vendor_id;

  IF v_email IS NULL OR length(trim(v_email)) = 0 THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.email_event_outbox
     WHERE event_type = 'purchase_order_released'
       AND entity_id = _po_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.email_event_outbox (
    organization_id, business_id, event_type, entity_type, entity_id,
    recipient_email, template_variables
  ) VALUES (
    r.organization_id, r.business_id, 'purchase_order_released',
    'purchase_order', r.id, v_email,
    jsonb_build_object(
      'po_number', r.po_number,
      'vendor_name', v_name,
      'order_date', r.order_date,
      'expected_date', r.expected_date,
      'currency', r.currency,
      'total', r.total
    )
  );
END $function$;

-- Declarative registry (mirrors the procurement.gr.posted registrations).
INSERT INTO public.business_event_subscriptions
  (event_type, subscriber_name, consumer_domain, handler_function, is_active)
VALUES
  ('procurement.po.released',  'wms.po_expected_inbound',    'warehouse',
   'public.wms_po_ensure_expected_inbound(uuid,uuid)', true),
  ('procurement.po.released',  'notify.po_supplier_release', 'notifications',
   'public.notify_po_supplier_release(uuid,uuid)', true),
  ('procurement.po.cancelled', 'wms.po_inbound_withdrawal',  'warehouse',
   'public.wms_po_withdraw_expected_inbound(uuid,uuid)', true),
  ('procurement.po.revised',   'wms.po_inbound_withdrawal',  'warehouse',
   'public.wms_po_withdraw_expected_inbound(uuid,uuid)', true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. release_purchase_order — the missing approved -> sent transition
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_purchase_order(p_po_id uuid)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;

  SELECT * INTO r FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;

  IF lower(coalesce(r.status::text,'')) = 'sent' THEN
    RETURN r; -- idempotent replay
  END IF;

  IF lower(coalesce(r.status::text,'')) <> 'approved' THEN
    RAISE EXCEPTION 'Purchase order is %, cannot release', r.status USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_orders
     SET status = 'sent', updated_at = now()
   WHERE id = p_po_id
   RETURNING * INTO r;

  PERFORM public._emit_po_outbox(r.business_id, r.id, 'released',
    jsonb_build_object('po_number', r.po_number, 'released_by', v_uid, 'total', r.total));

  -- Synchronous fan-out to the registered domain consumers, matching the
  -- shipped complete_goods_receipt_atomic pattern. Purchasing never writes
  -- warehouse or notification rows itself.
  PERFORM public.wms_po_ensure_expected_inbound(NULL::uuid, r.id);
  PERFORM public.notify_po_supplier_release(NULL::uuid, r.id);

  RETURN r;
END $function$;

-- Cancellation / revision must withdraw what release created.
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id uuid, p_reason text DEFAULT NULL::text)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF r.billing_status IN ('partially_billed','fully_billed') THEN
    RAISE EXCEPTION 'Purchase order has bills posted, cannot cancel' USING ERRCODE='22023';
  END IF;
  IF lower(coalesce(r.status::text,'')) IN ('cancelled','closed','received') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot cancel', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders
     SET status='cancelled', updated_at=now(),
         notes=COALESCE(notes,'') || E'\nCancelled: ' || COALESCE(p_reason,'')
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'cancelled',
    jsonb_build_object('po_number', r.po_number, 'cancelled_by', v_uid, 'reason', p_reason));
  PERFORM public.wms_po_withdraw_expected_inbound(NULL::uuid, r.id);
  RETURN r;
END $function$;

CREATE OR REPLACE FUNCTION public.revise_purchase_order(p_po_id uuid, p_reason text)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders; v_next_rev INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('approved','acknowledged','sent','submitted') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot revise', r.status USING ERRCODE='22023';
  END IF;
  IF r.billing_status IN ('partially_billed','fully_billed') THEN
    RAISE EXCEPTION 'Purchase order has bills posted, cannot revise' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(MAX(revision_number),0)+1 INTO v_next_rev
    FROM public.purchase_order_revisions WHERE purchase_order_id=p_po_id;

  INSERT INTO public.purchase_order_revisions
    (business_id, purchase_order_id, revision_number, snapshot, reason, revised_by)
  VALUES (
    r.business_id, r.id, v_next_rev,
    to_jsonb(r) || jsonb_build_object(
      'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
                FROM public.purchase_order_items i WHERE i.purchase_order_id = r.id)
    ),
    p_reason, v_uid
  );

  UPDATE public.purchase_orders
     SET status='revised', approved_by=NULL, approved_at=NULL,
         submitted_by=NULL, submitted_at=NULL,
         approval_client_request_id=NULL,
         vendor_confirmed_at=NULL, updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;

  PERFORM public._emit_po_outbox(r.business_id, r.id, 'revised',
    jsonb_build_object('po_number', r.po_number, 'revision_number', v_next_rev, 'reason', p_reason));
  PERFORM public.wms_po_withdraw_expected_inbound(NULL::uuid, r.id);
  RETURN r;
END $function$;

-- ---------------------------------------------------------------------
-- 4. Inventory expected (incoming) supply — a view, never stored stock
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.inventory_expected_supply
WITH (security_invoker = true) AS
SELECT
  po.organization_id,
  po.business_id,
  COALESCE(po.deliver_to_branch_id, po.branch_id) AS branch_id,
  po.deliver_to_warehouse_id                      AS warehouse_id,
  poi.product_id,
  sum(GREATEST(poi.quantity - COALESCE(poi.quantity_received, 0), 0)) AS expected_quantity,
  min(po.expected_date)                            AS earliest_expected_date,
  count(DISTINCT po.id)                            AS open_po_count
FROM public.purchase_orders po
JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id
WHERE poi.product_id IS NOT NULL
  AND lower(coalesce(po.status::text,'')) IN ('approved','sent','acknowledged','partial_received')
  AND GREATEST(poi.quantity - COALESCE(poi.quantity_received, 0), 0) > 0
GROUP BY 1,2,3,4,5;

GRANT SELECT ON public.inventory_expected_supply TO authenticated;
GRANT SELECT ON public.inventory_expected_supply TO service_role;

-- ---------------------------------------------------------------------
-- 5. A service item can never be stock-tracked
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._products_service_never_tracks_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.type = 'service' THEN
    NEW.track_inventory := false;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_products_service_never_tracks_stock ON public.products;
CREATE TRIGGER trg_products_service_never_tracks_stock
  BEFORE INSERT OR UPDATE OF type, track_inventory ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._products_service_never_tracks_stock();

UPDATE public.products
   SET track_inventory = false
 WHERE type = 'service' AND track_inventory IS TRUE;