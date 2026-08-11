CREATE OR REPLACE FUNCTION public.acknowledge_purchase_order(p_po_id uuid, p_vendor_notes text DEFAULT NULL::text)
RETURNS public.purchase_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  r public.purchase_orders;
  v_is_portal_vendor boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  -- Acknowledgement is the supplier's act. Allow either an internal user with
  -- business access, or the portal user of the supplier named on the order.
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = r.vendor_id AND c.portal_user_id = v_uid
  ) INTO v_is_portal_vendor;

  IF NOT v_is_portal_vendor
     AND NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;

  -- Segregation of duties applies to internal users only.
  IF NOT v_is_portal_vendor AND r.approved_by IS NOT NULL AND r.approved_by = v_uid THEN
    RAISE EXCEPTION 'Cannot acknowledge a purchase order you approved (SoD)' USING ERRCODE='42501';
  END IF;

  IF lower(coalesce(r.status::text,'')) = 'acknowledged' THEN
    RETURN r; -- idempotent replay
  END IF;

  IF lower(coalesce(r.status::text,'')) NOT IN ('approved','sent') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot acknowledge', r.status USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_orders
     SET status='acknowledged', vendor_confirmed_at=now(),
         vendor_notes=COALESCE(p_vendor_notes, vendor_notes), updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;

  PERFORM public._emit_po_outbox(r.business_id, r.id, 'acknowledged',
    jsonb_build_object('po_number', r.po_number, 'acknowledged_by', v_uid,
                       'by_portal_vendor', v_is_portal_vendor));
  RETURN r;
END $function$;