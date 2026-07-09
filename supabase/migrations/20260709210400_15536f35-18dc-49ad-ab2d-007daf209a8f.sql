-- 1. Remove the obsolete thin-wrapper overloads that make PostgREST RPC
--    resolution ambiguous. The canonical wider signatures (with DEFAULTs)
--    accept every call pattern the wrappers did, so dropping them is safe.
DROP FUNCTION IF EXISTS public.physical_count_approve(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.physical_count_submit(uuid, uuid);
DROP FUNCTION IF EXISTS public.physical_count_post(uuid, uuid);

-- 2. Make recount requests non-destructive: capture the prior counted
--    quantities and a round number into the append-only event stream before
--    resetting the flagged lines. Nothing is lost — the Recounts tab
--    reconstructs every round from physical_count_events.
CREATE OR REPLACE FUNCTION public.physical_count_request_recount(
  p_count_id uuid, p_user_id uuid, p_line_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD;
  v_n int;
  v_round int;
  v_prev jsonb;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001';
  END IF;
  IF v_c.state NOT IN ('in_review','counting') THEN
    RAISE EXCEPTION 'cannot request recount in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  -- Round number = number of prior recount requests + 1.
  SELECT COUNT(*) + 1 INTO v_round
    FROM public.physical_count_events
   WHERE count_id = p_count_id AND event_type = 'recount_requested';

  -- Snapshot the prior counted values BEFORE clearing them (non-destructive).
  SELECT jsonb_agg(jsonb_build_object(
           'line_id', id,
           'product_id', product_id,
           'previous_qty', counted_qty,
           'previous_variance', variance_qty
         ))
    INTO v_prev
    FROM public.physical_count_lines
   WHERE count_id = p_count_id AND id = ANY(p_line_ids);

  UPDATE public.physical_count_lines
     SET status = 'recount_required', counted_qty = NULL, recount_qty = NULL
   WHERE count_id = p_count_id AND id = ANY(p_line_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.physical_counts SET state = 'counting' WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'recount_requested', p_user_id,
          jsonb_build_object(
            'round', v_round,
            'lines', v_n,
            'previous', COALESCE(v_prev, '[]'::jsonb)
          ));

  RETURN jsonb_build_object('success', true, 'lines_reset', v_n, 'round', v_round);
END $function$;