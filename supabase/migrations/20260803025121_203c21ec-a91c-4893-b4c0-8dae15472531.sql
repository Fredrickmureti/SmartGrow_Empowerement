-- 1. Remove the legacy overloads that bypass the count control plane.
DROP FUNCTION IF EXISTS public.record_count(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.create_count_session(uuid, text, uuid[], text);

-- 2. Recount lines inherit the original line's assignee so queued work keeps its owner.
CREATE OR REPLACE FUNCTION public.request_count_recount(p_line_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_line record; v_session record; v_new_id uuid;
BEGIN
  SELECT * INTO v_line FROM public.wms_count_lines WHERE id = p_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'count line % not found', p_line_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_line.business_id) THEN RAISE EXCEPTION 'access denied'; END IF;

  SELECT * INTO v_session FROM public.wms_count_sessions WHERE id = v_line.session_id;
  IF v_session.state IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'session in state % cannot be recounted', v_session.state;
  END IF;

  IF EXISTS (SELECT 1 FROM public.wms_count_lines WHERE recount_of_line_id = p_line_id) THEN
    RAISE EXCEPTION 'line % already has a recount attempt', p_line_id USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id, location_id, product_id,
    lot_number, system_qty, note, recount_of_line_id, recount_round,
    tolerance_outcome, assigned_to
  ) VALUES (
    v_line.session_id, v_line.organization_id, v_line.business_id,
    v_line.location_id, v_line.product_id, v_line.lot_number, v_line.system_qty,
    p_reason, p_line_id, v_line.recount_round + 1, NULL, v_line.assigned_to
  ) RETURNING id INTO v_new_id;

  -- The superseded attempt stops contributing to the roll-up.
  UPDATE public.wms_count_lines
     SET tolerance_outcome = 'recount_required'
   WHERE id = p_line_id;

  UPDATE public.wms_count_sessions
     SET recount_round = GREATEST(recount_round, v_line.recount_round + 1),
         state = 'counting'
   WHERE id = v_line.session_id;

  RETURN v_new_id;
END $function$;