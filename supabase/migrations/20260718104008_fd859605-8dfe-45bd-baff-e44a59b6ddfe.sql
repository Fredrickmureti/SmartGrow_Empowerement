
-- 1. Revisions table
CREATE TABLE public.purchase_order_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  reason TEXT,
  revised_by UUID,
  revised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchase_order_revisions_po_rev_idx
  ON public.purchase_order_revisions(purchase_order_id, revision_number);
CREATE INDEX purchase_order_revisions_business_idx
  ON public.purchase_order_revisions(business_id);

GRANT SELECT ON public.purchase_order_revisions TO authenticated;
GRANT ALL ON public.purchase_order_revisions TO service_role;
ALTER TABLE public.purchase_order_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "po_revisions_read"
  ON public.purchase_order_revisions FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

-- 2. Helper: emit procurement outbox
CREATE OR REPLACE FUNCTION public._emit_po_outbox(
  _business_id UUID, _po_id UUID, _state TEXT, _payload JSONB
) RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (business_id, source, event_type, entity_id, payload, idempotency_key, status, created_at)
  VALUES (
    _business_id,
    'procurement',
    'procurement.po.' || _state,
    _po_id,
    _payload,
    'procurement.po.' || _state || ':' || _po_id::text || ':' || _state,
    'pending',
    now()
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

-- 3. submit_purchase_order
CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_po_id UUID)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('draft','revised') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot submit', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders
     SET status='submitted', submitted_by=v_uid, submitted_at=now(), updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'submitted',
    jsonb_build_object('po_number', r.po_number, 'submitted_by', v_uid));
  RETURN r;
END $$;

-- 4. approve_purchase_order (replace: add self-approval block + outbox)
CREATE OR REPLACE FUNCTION public.approve_purchase_order(p_po_id UUID)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF r.submitted_by IS NOT NULL AND r.submitted_by = v_uid THEN
    RAISE EXCEPTION 'Cannot approve a purchase order you submitted (SoD)' USING ERRCODE='42501';
  END IF;
  IF r.created_by IS NOT NULL AND r.created_by = v_uid THEN
    RAISE EXCEPTION 'Cannot approve a purchase order you created (SoD)' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('draft','submitted') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot approve', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders
     SET status='approved', approved_by=v_uid, approved_at=now(), updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'approved',
    jsonb_build_object('po_number', r.po_number, 'approved_by', v_uid, 'total', r.total));
  RETURN r;
END $$;

-- 5. reject_purchase_order
CREATE OR REPLACE FUNCTION public.reject_purchase_order(p_po_id UUID, p_reason TEXT)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF r.submitted_by IS NOT NULL AND r.submitted_by = v_uid THEN
    RAISE EXCEPTION 'Cannot reject a purchase order you submitted (SoD)' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('submitted') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot reject', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders SET status='rejected', updated_at=now(), notes=COALESCE(notes,'') || E'\nRejected: ' || COALESCE(p_reason,'')
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'rejected',
    jsonb_build_object('po_number', r.po_number, 'rejected_by', v_uid, 'reason', p_reason));
  RETURN r;
END $$;

-- 6. acknowledge_purchase_order (vendor / buyer confirms sent)
CREATE OR REPLACE FUNCTION public.acknowledge_purchase_order(p_po_id UUID, p_vendor_notes TEXT DEFAULT NULL)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF r.approved_by IS NOT NULL AND r.approved_by = v_uid THEN
    RAISE EXCEPTION 'Cannot acknowledge a purchase order you approved (SoD)' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) NOT IN ('approved','sent') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot acknowledge', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders
     SET status='acknowledged', vendor_confirmed_at=now(),
         vendor_notes=COALESCE(p_vendor_notes, vendor_notes), updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'acknowledged',
    jsonb_build_object('po_number', r.po_number, 'acknowledged_by', v_uid));
  RETURN r;
END $$;

-- 7. revise_purchase_order — snapshot + return to draft-like `revised` state
CREATE OR REPLACE FUNCTION public.revise_purchase_order(p_po_id UUID, p_reason TEXT)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
         vendor_confirmed_at=NULL, updated_at=now()
   WHERE id=p_po_id RETURNING * INTO r;

  PERFORM public._emit_po_outbox(r.business_id, r.id, 'revised',
    jsonb_build_object('po_number', r.po_number, 'revision_number', v_next_rev, 'reason', p_reason));
  RETURN r;
END $$;

-- 8. cancel_purchase_order
CREATE OR REPLACE FUNCTION public.cancel_purchase_order(p_po_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
  RETURN r;
END $$;

-- 9. close_purchase_order (final: everything received & billed OR manual close)
CREATE OR REPLACE FUNCTION public.close_purchase_order(p_po_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS public.purchase_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_uid UUID := auth.uid(); r public.purchase_orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO r FROM public.purchase_orders WHERE id=p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, r.business_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF lower(coalesce(r.status::text,'')) IN ('draft','cancelled','closed','rejected') THEN
    RAISE EXCEPTION 'Purchase order is %, cannot close', r.status USING ERRCODE='22023';
  END IF;
  UPDATE public.purchase_orders SET status='closed', updated_at=now(),
    notes=CASE WHEN p_reason IS NOT NULL THEN COALESCE(notes,'') || E'\nClosed: ' || p_reason ELSE notes END
   WHERE id=p_po_id RETURNING * INTO r;
  PERFORM public._emit_po_outbox(r.business_id, r.id, 'closed',
    jsonb_build_object('po_number', r.po_number, 'closed_by', v_uid, 'reason', p_reason));
  RETURN r;
END $$;

-- 10. Governance duties + SoD
INSERT INTO public.governance_duties (duty_code, label, description, domain) VALUES
  ('po.submit','Submit purchase orders','Submit a PO for approval','purchasing'),
  ('po.acknowledge','Acknowledge purchase orders','Confirm vendor receipt / acknowledgement','purchasing'),
  ('po.close','Close purchase orders','Final close of a PO lifecycle','purchasing'),
  ('po.revise','Revise purchase orders','Create a new revision after approval','purchasing'),
  ('po.reject','Reject purchase orders','Reject a submitted PO','purchasing')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, rationale) VALUES
  ('po.approve','po.create','The creator of a PO must not be the approver'),
  ('po.approve','po.submit','The submitter of a PO must not be the approver'),
  ('po.acknowledge','po.approve','The approver of a PO must not acknowledge it'),
  ('po.approve','po.reject','A user reviewing a PO must not both approve and reject it'),
  ('po.approve','po.revise','A revision must be re-approved by someone other than the reviser')
ON CONFLICT DO NOTHING;
