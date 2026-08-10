-- C1: quantity-driven rollup state machine
CREATE OR REPLACE FUNCTION public._pr_recalc(_requisition_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_r public.purchase_requisitions; v_status text;
BEGIN
  IF _requisition_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id;
  IF v_r.id IS NULL THEN RETURN; END IF;

  PERFORM public._pr_lifecycle_begin();

  WITH agg AS (
    SELECT i.id,
           COALESCE(sum(poi.quantity), 0)          AS qty_ordered,
           COALESCE(sum(poi.quantity_received), 0) AS qty_received,
           bool_or(ri.id IS NOT NULL)              AS sourcing
      FROM public.purchase_requisition_items i
      LEFT JOIN public.purchase_order_items poi
             ON poi.requisition_item_id = i.id
            AND EXISTS (SELECT 1 FROM public.purchase_orders po
                         WHERE po.id = poi.purchase_order_id
                           AND po.status <> 'cancelled')
      LEFT JOIN public.rfq_items ri ON ri.requisition_item_id = i.id
     WHERE i.requisition_id = _requisition_id
     GROUP BY i.id
  )
  UPDATE public.purchase_requisition_items i
     SET quantity_ordered  = COALESCE(a.qty_ordered, 0),
         quantity_received = COALESCE(a.qty_received, 0),
         status = CASE
           WHEN i.status = 'cancelled' THEN 'cancelled'
           -- short-closed: outstanding demand deliberately withdrawn
           WHEN COALESCE(i.quantity_cancelled, 0) > 0
                AND COALESCE(a.qty_ordered, 0) + COALESCE(i.quantity_cancelled, 0)
                    >= i.quantity - 0.000001 THEN 'closed'
           WHEN i.quantity > 0
                AND COALESCE(a.qty_received, 0) >= i.quantity - 0.000001 THEN 'received'
           WHEN COALESCE(a.qty_received, 0) > 0 THEN 'partially_received'
           WHEN i.quantity > 0
                AND COALESCE(a.qty_ordered, 0) >= i.quantity - 0.000001 THEN 'ordered'
           WHEN COALESCE(a.qty_ordered, 0) > 0 THEN 'partially_ordered'
           WHEN COALESCE(a.sourcing, false) THEN 'sourcing'
           ELSE 'open' END,
         updated_at = now()
    FROM agg a
   WHERE i.id = a.id;

  IF v_r.status IN ('draft','submitted','rejected','cancelled') THEN
    RETURN;
  END IF;

  SELECT CASE
      WHEN count(*) = 0 THEN v_r.status
      WHEN count(*) FILTER (WHERE status <> 'cancelled') = 0 THEN 'cancelled'
      -- every live line is terminal (received or short-closed)
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','closed','received')) = 0
           AND count(*) FILTER (WHERE status = 'closed') > 0 THEN 'closed'
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','received')) = 0 THEN 'fulfilled'
      WHEN count(*) FILTER (WHERE status IN ('received','partially_received')) > 0
           THEN 'partially_fulfilled'
      -- fully covered by purchase orders, nothing received yet
      WHEN count(*) FILTER (WHERE status NOT IN ('cancelled','closed','ordered')) = 0
           AND count(*) FILTER (WHERE status = 'ordered') > 0 THEN 'procured'
      WHEN count(*) FILTER (WHERE status IN ('ordered','partially_ordered')) > 0
           THEN 'partially_procured'
      WHEN count(*) FILTER (WHERE status = 'sourcing') > 0 THEN 'sourcing'
      ELSE 'approved' END
    INTO v_status
    FROM public.purchase_requisition_items WHERE requisition_id = _requisition_id;

  IF v_status IS DISTINCT FROM v_r.status THEN
    UPDATE public.purchase_requisitions
       SET status = v_status,
           closed_at = CASE WHEN v_status IN ('closed','fulfilled') THEN COALESCE(closed_at, now())
                            ELSE closed_at END,
           updated_at = now()
     WHERE id = _requisition_id;
  END IF;
END
$fn$;

-- C2: short-close a single requisition line
CREATE OR REPLACE FUNCTION public.requisition_close_line(_item_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_i public.purchase_requisition_items; v_r public.purchase_requisitions;
        v_uid uuid := auth.uid(); v_outstanding numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_i FROM public.purchase_requisition_items WHERE id = _item_id FOR UPDATE;
  IF v_i.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition line not found'); END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = v_i.requisition_id FOR UPDATE;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status NOT IN ('approved','sourcing','partially_procured','procured','partially_fulfilled') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only an approved requisition that is still being procured can be short-closed');
  END IF;
  IF v_i.status IN ('cancelled','closed','received') THEN
    -- idempotent: nothing outstanding to withdraw
    RETURN jsonb_build_object('success', true, 'already_closed', true);
  END IF;

  v_outstanding := GREATEST(v_i.quantity - COALESCE(v_i.quantity_ordered,0) - COALESCE(v_i.quantity_cancelled,0), 0);
  IF v_outstanding <= 0.000001 THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true);
  END IF;

  PERFORM public._pr_lifecycle_begin();
  UPDATE public.purchase_requisition_items
     SET quantity_cancelled = COALESCE(quantity_cancelled,0) + v_outstanding,
         notes = CASE WHEN _reason IS NULL OR btrim(_reason) = '' THEN notes
                      ELSE COALESCE(notes || E'\n', '') || 'Short-closed: ' || _reason END,
         updated_at = now()
   WHERE id = _item_id;

  PERFORM public._pr_recalc(v_i.requisition_id);

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.line_closed',
          'purchase_requisition', v_r.id,
          jsonb_build_object('requisition_item_id', _item_id,
                             'quantity_withdrawn', v_outstanding,
                             'reason', _reason),
          'procurement.requisition.line_closed:' || _item_id::text || ':' ||
            to_char(now(), 'YYYYMMDDHH24MISSUS'),
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'quantity_withdrawn', v_outstanding);
END
$fn$;

-- C2: short-close the whole requisition
CREATE OR REPLACE FUNCTION public.requisition_close(_requisition_id uuid, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_r public.purchase_requisitions; v_uid uuid := auth.uid(); v_line record; v_n int := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM public.purchase_requisitions WHERE id = _requisition_id FOR UPDATE;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Requisition not found'); END IF;
  IF NOT public.user_has_business_access(v_uid, v_r.business_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Access denied');
  END IF;
  IF v_r.status IN ('closed','cancelled','rejected') THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true);
  END IF;
  IF v_r.status IN ('draft','submitted') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'A requisition that has not been approved should be cancelled, not closed');
  END IF;

  FOR v_line IN
    SELECT id FROM public.purchase_requisition_items
     WHERE requisition_id = _requisition_id
       AND status NOT IN ('cancelled','closed','received')
  LOOP
    PERFORM public.requisition_close_line(v_line.id, _reason);
    v_n := v_n + 1;
  END LOOP;

  PERFORM public._pr_lifecycle_begin();
  PERFORM public._pr_recalc(_requisition_id);

  UPDATE public.purchase_requisitions
     SET status = 'closed', closed_at = COALESCE(closed_at, now()), updated_at = now()
   WHERE id = _requisition_id AND status <> 'closed';

  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (v_r.organization_id, 'procurement.requisition.closed',
          'purchase_requisition', _requisition_id,
          jsonb_build_object('reason', _reason, 'lines_short_closed', v_n),
          'procurement.requisition.closed:' || _requisition_id::text,
          v_uid, 'procurement')
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'lines_short_closed', v_n);
END
$fn$;

REVOKE ALL ON FUNCTION public.requisition_close_line(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.requisition_close(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.requisition_close_line(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.requisition_close(uuid, text) TO authenticated;

-- C3: register requisition.submit as a governed action
INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description, severity_default, is_active, requires_approval_always)
VALUES
  ('requisition.submit', 'Purchasing', 'purchase_requisitions', 'actor',
   'Submit purchase requisition',
   'Releases an internal spend request for approval routing.',
   'standard', true, false)
ON CONFLICT (action_key) DO NOTHING;
