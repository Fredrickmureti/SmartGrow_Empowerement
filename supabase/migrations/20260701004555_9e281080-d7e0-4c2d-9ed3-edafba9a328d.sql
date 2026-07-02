-- Extend payroll_return_transition to write authoritative metadata fields
-- from the caller's payload in the SAME transaction as the status change.
-- This closes the state-machine bypass in submit-statutory-return which
-- previously performed a direct UPDATE after asserting the edge, skipping
-- the audit → outbox trigger for `submitted`/`acknowledged` states.
--
-- Payload keys applied (all optional, safely coerced):
--   submitted_at, submitted_by (uuid), submission_channel,
--   filed_at, filed_reference,
--   acknowledged_at,
--   authority_ack_payload (jsonb),
--   rejection_reasons (jsonb[])
--
-- Unknown payload keys are preserved on the audit row but not written to
-- the runs table — the transition remains the sole gatekeeper.

CREATE OR REPLACE FUNCTION public.payroll_return_transition(
  _run_id uuid, _to_status text, _reason text DEFAULT NULL, _payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.payroll_return_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.payroll_return_runs;
  v_prev text;
  v_actor uuid := auth.uid();
  v_valid boolean := false;
  v_payload jsonb := COALESCE(_payload, '{}'::jsonb);
BEGIN
  SELECT * INTO v_run FROM public.payroll_return_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run % not found', _run_id USING ERRCODE='P0002'; END IF;
  v_prev := v_run.status;
  IF v_prev = _to_status THEN RETURN v_run; END IF;
  v_valid := CASE v_prev
    WHEN 'draft'        THEN _to_status IN ('generated','cancelled')
    WHEN 'generated'    THEN _to_status IN ('filed','superseded','cancelled','draft')
    WHEN 'filed'        THEN _to_status IN ('acknowledged','rejected','superseded')
    WHEN 'rejected'     THEN _to_status IN ('draft','superseded')
    WHEN 'acknowledged' THEN _to_status IN ('archived','superseded')
    WHEN 'superseded'   THEN _to_status IN ('archived')
    WHEN 'cancelled'    THEN _to_status IN ('archived')
    ELSE false
  END;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'illegal transition: % -> %', v_prev, _to_status USING ERRCODE='22023';
  END IF;

  UPDATE public.payroll_return_runs
     SET status              = _to_status,
         state_updated_at    = now(),
         state_updated_by    = v_actor,
         submitted_at        = COALESCE((v_payload->>'submitted_at')::timestamptz, submitted_at),
         submitted_by        = COALESCE(NULLIF(v_payload->>'submitted_by','')::uuid, submitted_by),
         submission_channel  = COALESCE(v_payload->>'submission_channel', submission_channel),
         filed_at            = COALESCE((v_payload->>'filed_at')::timestamptz, filed_at),
         filed_reference     = COALESCE(v_payload->>'filed_reference', filed_reference),
         acknowledged_at     = COALESCE((v_payload->>'acknowledged_at')::timestamptz, acknowledged_at),
         authority_ack_payload = COALESCE(v_payload->'authority_ack_payload', authority_ack_payload),
         rejection_reasons   = CASE
             WHEN v_payload ? 'rejection_reasons' AND jsonb_typeof(v_payload->'rejection_reasons') = 'array'
               THEN ARRAY(SELECT jsonb_array_elements_text(v_payload->'rejection_reasons'))
             ELSE rejection_reasons
           END
   WHERE id = _run_id RETURNING * INTO v_run;

  INSERT INTO public.pack_return_run_audit
    (run_id, organization_id, business_id, from_status, to_status, actor_user_id, reason, payload)
  VALUES (v_run.id, v_run.organization_id, v_run.business_id, v_prev, _to_status,
          v_actor, _reason, v_payload);
  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) TO authenticated, service_role;