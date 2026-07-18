
-- 1. Line validation trigger --------------------------------------------
CREATE OR REPLACE FUNCTION public._validate_inbound_shipment_item()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE h RECORD;
BEGIN
  SELECT organization_id, business_id INTO h
    FROM public.inbound_shipments WHERE id = NEW.shipment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shipment % not found', NEW.shipment_id; END IF;
  IF NEW.organization_id <> h.organization_id OR NEW.business_id <> h.business_id THEN
    RAISE EXCEPTION 'Line org/business must match the shipment header';
  END IF;
  IF COALESCE(NEW.expected_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Expected quantity must be positive (got %)', NEW.expected_quantity;
  END IF;
  IF NEW.expected_expiry_date IS NOT NULL AND NEW.expected_manufacture_date IS NOT NULL
     AND NEW.expected_expiry_date < NEW.expected_manufacture_date THEN
    RAISE EXCEPTION 'Expiry cannot precede manufacture date';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_inbound_shipment_item ON public.inbound_shipment_items;
CREATE TRIGGER trg_validate_inbound_shipment_item
BEFORE INSERT OR UPDATE ON public.inbound_shipment_items
FOR EACH ROW EXECUTE FUNCTION public._validate_inbound_shipment_item();

-- 2. Outbox emit helper -------------------------------------------------
CREATE OR REPLACE FUNCTION public._emit_asn_outbox(_shipment_id uuid, _state text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.inbound_shipments WHERE id=_shipment_id;
  INSERT INTO public.business_event_outbox
    (org_id, source, event_type, source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (v_org, 'procurement', 'procurement.asn.' || _state,
          'inbound_shipment', _shipment_id, _payload,
          'procurement.asn.' || _state || ':' || _shipment_id::text || ':' || _state,
          'pending', auth.uid(), now())
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

-- 3. Lifecycle RPCs -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_inbound_shipment(
  p_business_id uuid,
  p_vendor_id uuid,
  p_purchase_order_id uuid,
  p_expected_arrival_at timestamptz,
  p_carrier text DEFAULT NULL,
  p_tracking_number text DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_num text;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id=p_business_id;
  v_num := 'ASN-' || to_char(now(),'YYYYMMDD') || '-' || substr(v_id::text,1,8);

  INSERT INTO public.inbound_shipments
    (id, organization_id, business_id, branch_id, warehouse_id,
     purchase_order_id, vendor_id, shipment_number,
     carrier, tracking_number, status, expected_arrival_at, notes,
     created_by, created_at, updated_at)
  VALUES (v_id, v_org, p_business_id, p_branch_id, p_warehouse_id,
          p_purchase_order_id, p_vendor_id, v_num,
          p_carrier, p_tracking_number, 'draft', p_expected_arrival_at, p_notes,
          v_uid, now(), now());

  PERFORM public._emit_asn_outbox(v_id, 'created',
    jsonb_build_object('shipment_number', v_num, 'purchase_order_id', p_purchase_order_id,
                       'vendor_id', p_vendor_id, 'expected_arrival_at', p_expected_arrival_at));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_inbound_shipment(p_shipment_id uuid, p_dispatched_at timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid := auth.uid(); r RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.inbound_shipments WHERE id=p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF r.status::text <> 'draft' THEN
    RAISE EXCEPTION 'shipment is % — expected draft', r.status;
  END IF;
  UPDATE public.inbound_shipments
     SET status='dispatched', dispatched_at=p_dispatched_at, updated_at=now()
   WHERE id=p_shipment_id;
  PERFORM public._emit_asn_outbox(p_shipment_id,'dispatched',
    jsonb_build_object('dispatched_at', p_dispatched_at, 'by', v_uid));
END $$;

CREATE OR REPLACE FUNCTION public.mark_inbound_shipment_in_transit(p_shipment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid := auth.uid(); r RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.inbound_shipments WHERE id=p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF r.status::text NOT IN ('draft','dispatched') THEN
    RAISE EXCEPTION 'shipment is % — cannot mark in_transit', r.status;
  END IF;
  UPDATE public.inbound_shipments SET status='in_transit', updated_at=now() WHERE id=p_shipment_id;
  PERFORM public._emit_asn_outbox(p_shipment_id,'in_transit', jsonb_build_object('by', v_uid));
END $$;

CREATE OR REPLACE FUNCTION public.mark_inbound_shipment_arrived(p_shipment_id uuid, p_arrived_at timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid := auth.uid(); r RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.inbound_shipments WHERE id=p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF r.status::text NOT IN ('dispatched','in_transit') THEN
    RAISE EXCEPTION 'shipment is % — cannot mark arrived', r.status;
  END IF;
  UPDATE public.inbound_shipments SET status='arrived', arrived_at=p_arrived_at, updated_at=now() WHERE id=p_shipment_id;
  PERFORM public._emit_asn_outbox(p_shipment_id,'arrived',
    jsonb_build_object('arrived_at', p_arrived_at, 'by', v_uid));
END $$;

CREATE OR REPLACE FUNCTION public.cancel_inbound_shipment(p_shipment_id uuid, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid := auth.uid(); r RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.inbound_shipments WHERE id=p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF r.status::text IN ('received','cancelled') THEN
    RAISE EXCEPTION 'shipment is % — terminal', r.status;
  END IF;
  UPDATE public.inbound_shipments SET status='cancelled', updated_at=now() WHERE id=p_shipment_id;
  PERFORM public._emit_asn_outbox(p_shipment_id,'cancelled',
    jsonb_build_object('reason', p_reason, 'by', v_uid));
END $$;

CREATE OR REPLACE FUNCTION public.update_inbound_shipment_eta(p_shipment_id uuid, p_expected_arrival_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid uuid := auth.uid(); r RECORD;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO r FROM public.inbound_shipments WHERE id=p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shipment not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF r.status::text IN ('received','cancelled') THEN
    RAISE EXCEPTION 'shipment is % — terminal', r.status;
  END IF;
  UPDATE public.inbound_shipments SET expected_arrival_at=p_expected_arrival_at, updated_at=now() WHERE id=p_shipment_id;
  PERFORM public._emit_asn_outbox(p_shipment_id,'eta_updated',
    jsonb_build_object('expected_arrival_at', p_expected_arrival_at, 'by', v_uid));
END $$;

-- 4. Governance duty + SoD ---------------------------------------------
INSERT INTO public.governance_duties (duty_code, label, description, domain)
VALUES ('asn.manage','Manage ASN / inbound shipments','Create, dispatch, and update advance shipping notices.','procurement')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale)
VALUES ('asn.manage','po.approve','high','ASN manager must not approve the underlying PO.'),
       ('asn.manage','po.receive','high','ASN manager must not also record physical receipt.')
ON CONFLICT DO NOTHING;
