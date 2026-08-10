-- 1. Register the award action so policy can gate it independently of rfq.approve
INSERT INTO public.governance_action_registry
  (action_key, label, description, module, severity_default, subject_mode, subject_table, requires_approval_always, is_active)
VALUES
  ('rfq.award', 'Award RFQ',
   'Select the winning supplier offer(s) on a request for quotation.',
   'Purchasing', 'high', 'actor', 'rfqs', false, true)
ON CONFLICT (action_key) DO NOTHING;

-- 2. Award-stage approval linkage
ALTER TABLE public.rfqs
  ADD COLUMN IF NOT EXISTS award_approval_request_id uuid REFERENCES public.approval_requests(id);

-- 3. rfq_award: SoD floor + canonical approval routing
CREATE OR REPLACE FUNCTION public.rfq_award(
  _rfq_id uuid,
  _awards jsonb,
  _justification text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v public.rfqs; a jsonb; l jsonb; q public.rfq_quotations;
  v_award_id uuid; v_total numeric; v_awarded_lines int := 0; v_demand int; v_covered int;
  v_grand numeric := 0;
  v_req public.approval_requests;
BEGIN
  v := _rfq_guard(_rfq_id, ARRAY['responses_received','under_evaluation','sent']);
  IF _justification IS NULL OR btrim(_justification) = '' THEN
    RAISE EXCEPTION 'An award justification is required';
  END IF;
  IF jsonb_array_length(COALESCE(_awards,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Nothing to award';
  END IF;
  IF EXISTS (SELECT 1 FROM rfq_awards WHERE rfq_id = _rfq_id) THEN
    RAISE EXCEPTION 'RFQ % has already been awarded', v.rfq_number;
  END IF;

  -- Segregation of duties floor: awarding is a separate decision from
  -- approving the sourcing exercise, and from raising it.
  IF v.approved_by IS NOT NULL AND v.approved_by = auth.uid() THEN
    RAISE EXCEPTION 'Segregation of duties: an RFQ cannot be awarded by the user who approved it'
      USING ERRCODE = '42501', HINT = 'GOV_SOD_CONFLICT';
  END IF;
  IF v.submitted_by IS NOT NULL AND v.submitted_by = auth.uid()
     AND v.approved_by IS DISTINCT FROM auth.uid() AND v.approved_by IS NULL THEN
    RAISE EXCEPTION 'Segregation of duties: an RFQ cannot be awarded by the user who submitted it'
      USING ERRCODE = '42501', HINT = 'GOV_SOD_CONFLICT';
  END IF;

  FOR a IN SELECT * FROM jsonb_array_elements(_awards) LOOP
    SELECT * INTO q FROM rfq_quotations
     WHERE id = (a->>'quotation_id')::uuid AND rfq_id = _rfq_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found on this RFQ'; END IF;
    IF q.state <> 'submitted' THEN RAISE EXCEPTION 'Quotation is % and cannot be awarded', q.state; END IF;

    INSERT INTO rfq_awards (rfq_id, supplier_id, quotation_id, currency, award_reason, awarded_by)
    VALUES (_rfq_id, q.supplier_id, q.id, q.currency, a->>'reason', auth.uid())
    RETURNING id INTO v_award_id;

    FOR l IN SELECT * FROM jsonb_array_elements(a->'lines') LOOP
      INSERT INTO rfq_award_items (award_id, rfq_item_id, quotation_item_id, awarded_quantity,
        awarded_uom_id, unit_price, tax_rate, line_total)
      SELECT v_award_id, qi.rfq_item_id, qi.id,
        (l->>'awarded_quantity')::numeric, qi.quoted_uom_id, qi.unit_price, qi.tax_rate,
        ROUND((l->>'awarded_quantity')::numeric * qi.unit_price, 6)
      FROM rfq_quotation_items qi
      WHERE qi.id = (l->>'quotation_item_id')::uuid AND qi.quotation_id = q.id
        AND (l->>'awarded_quantity')::numeric > 0
        AND (l->>'awarded_quantity')::numeric <= qi.quoted_quantity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Awarded quantity exceeds the quantity quoted, or the line does not belong to this quotation';
      END IF;
      v_awarded_lines := v_awarded_lines + 1;
    END LOOP;

    SELECT COALESCE(SUM(line_total),0) INTO v_total FROM rfq_award_items WHERE award_id = v_award_id;
    UPDATE rfq_awards SET awarded_value = v_total WHERE id = v_award_id;
    UPDATE rfq_quotations SET state = 'awarded' WHERE id = q.id;
    v_grand := v_grand + v_total;
  END LOOP;

  UPDATE rfq_quotations SET state = 'rejected'
   WHERE rfq_id = _rfq_id AND state = 'submitted';

  SELECT count(*) INTO v_demand FROM rfq_items WHERE rfq_id = _rfq_id;
  SELECT count(DISTINCT ai.rfq_item_id) INTO v_covered
    FROM rfq_award_items ai JOIN rfq_awards aw ON aw.id = ai.award_id WHERE aw.rfq_id = _rfq_id;

  UPDATE rfqs SET status = CASE WHEN v_covered >= v_demand THEN 'awarded' ELSE 'partially_awarded' END,
    awarded_by = auth.uid(), awarded_at = now(), award_justification = _justification,
    updated_at = now() WHERE id = _rfq_id;

  -- Canonical engine. Returns NULL when policy does not gate the award.
  v_req := public.approval_route(
    'rfq.award', 'rfq', _rfq_id, v.rfq_number,
    jsonb_build_object('amount', v_grand, 'total_amount', v_grand,
                       'currency', v.currency, 'version', v.version,
                       'message', _justification),
    jsonb_build_object('organization_id', v.organization_id),
    'rfq.award:' || _rfq_id::text || ':v' || v.version::text,
    v.business_id);

  UPDATE rfqs SET award_approval_request_id = v_req.id, updated_at = now()
   WHERE id = _rfq_id;

  PERFORM _rfq_emit(v, 'rfq.awarded',
    jsonb_build_object('lines', v_awarded_lines, 'suppliers', jsonb_array_length(_awards),
                       'awarded_value', v_grand,
                       'approval_request_id', v_req.id), auth.uid());

  RETURN jsonb_build_object('success', true, 'awarded_lines', v_awarded_lines,
    'fully_awarded', v_covered >= v_demand,
    'awarded_value', v_grand,
    'approval_request_id', v_req.id,
    'gated', v_req.id IS NOT NULL);
END;
$function$;

-- 4. Conversion must refuse while an award decision is outstanding
CREATE OR REPLACE FUNCTION public._rfq_assert_award_decided(_rfq_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_req_id uuid;
  v_status text;
BEGIN
  SELECT award_approval_request_id INTO v_req_id FROM public.rfqs WHERE id = _rfq_id;
  IF v_req_id IS NULL THEN RETURN; END IF;
  SELECT status INTO v_status FROM public.approval_requests WHERE id = v_req_id;
  IF v_status IN ('pending','in_review','escalated') THEN
    RAISE EXCEPTION 'The award on this RFQ is awaiting approval request % — decide it in Approvals before converting to purchase orders', v_req_id
      USING ERRCODE = '42501', HINT = 'GOV_USE_APPROVAL_ENGINE';
  END IF;
END;
$function$;

-- 5. Mirror award decisions from the canonical engine back onto the RFQ
CREATE OR REPLACE FUNCTION public._mirror_approval_to_rfq()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rfq public.rfqs;
  v_actor uuid;
BEGIN
  -- Single canonical engine: this mirror is how governance decisions reach
  -- the RFQ module. Do NOT add a second approval engine for purchasing.
  IF NEW.entity_type <> 'rfq' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rfq FROM public.rfqs WHERE id = NEW.entity_id;
  IF v_rfq.id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT h.actor_user_id INTO v_actor
    FROM public.approval_history h
   WHERE h.request_id = NEW.id AND h.actor_user_id IS NOT NULL
   ORDER BY h.created_at DESC
   LIMIT 1;
  v_actor := COALESCE(auth.uid(), v_actor);

  IF NEW.action_key = 'rfq.award' THEN
    IF NEW.status = 'approved' THEN
      PERFORM public._rfq_emit(v_rfq, 'rfq.award_approved',
        jsonb_build_object('approval_request_id', NEW.id), v_actor);
    ELSIF NEW.status IN ('rejected','cancelled') THEN
      -- Undo the award completely; the sourcing exercise returns to evaluation.
      DELETE FROM public.rfq_award_items ai
       USING public.rfq_awards aw
       WHERE ai.award_id = aw.id AND aw.rfq_id = v_rfq.id;
      DELETE FROM public.rfq_awards WHERE rfq_id = v_rfq.id;
      UPDATE public.rfq_quotations
         SET state = 'submitted'
       WHERE rfq_id = v_rfq.id AND state IN ('awarded','rejected');
      UPDATE public.rfqs
         SET status = 'responses_received',
             awarded_by = NULL,
             awarded_at = NULL,
             award_justification = NULL,
             award_approval_request_id = NULL,
             updated_at = now()
       WHERE id = v_rfq.id;
      PERFORM public._rfq_emit(v_rfq, 'rfq.award_rejected',
        jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status), v_actor);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'approved',
           approved_by = v_actor,
           approved_at = now(),
           approval_request_id = NEW.id,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.approved',
      jsonb_build_object('approval_request_id', NEW.id), v_actor);
  ELSIF NEW.status IN ('rejected','cancelled') AND v_rfq.status = 'pending_approval' THEN
    UPDATE public.rfqs
       SET status = 'draft',
           submitted_by = NULL,
           submitted_at = NULL,
           approval_request_id = NULL,
           updated_at = now()
     WHERE id = v_rfq.id;
    PERFORM public._rfq_emit(v_rfq, 'rfq.rejected',
      jsonb_build_object('approval_request_id', NEW.id, 'status', NEW.status), v_actor);
  END IF;

  RETURN NEW;
END;
$function$;