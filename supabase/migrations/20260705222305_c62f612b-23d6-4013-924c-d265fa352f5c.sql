CREATE OR REPLACE FUNCTION public.payroll_return_transition(
  _run_id uuid,
  _to_status text,
  _reason text DEFAULT NULL::text,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.payroll_return_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_run public.payroll_return_runs;
  v_prev text;
  v_actor uuid := auth.uid();
  v_payload jsonb := COALESCE(_payload, '{}'::jsonb);
BEGIN
  SELECT * INTO v_run
    FROM public.payroll_return_runs
   WHERE id = _run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'run % not found', _run_id USING ERRCODE='P0002';
  END IF;

  v_prev := v_run.status;
  IF v_prev = _to_status THEN
    RETURN v_run;
  END IF;

  PERFORM public.payroll_return_assert_transition(v_prev, _to_status);

  UPDATE public.payroll_return_runs
     SET status = _to_status,
         state_updated_at = now(),
         state_transitioned_at = now(),
         state_updated_by = v_actor,
         submitted_at = COALESCE((v_payload->>'submitted_at')::timestamptz, submitted_at),
         submitted_by = COALESCE(NULLIF(v_payload->>'submitted_by','')::uuid, submitted_by),
         submission_channel = COALESCE(v_payload->>'submission_channel', submission_channel),
         filed_at = COALESCE((v_payload->>'filed_at')::timestamptz, filed_at),
         filed_reference = COALESCE(v_payload->>'filed_reference', filed_reference),
         acknowledged_at = COALESCE((v_payload->>'acknowledged_at')::timestamptz, acknowledged_at),
         authority_ack_payload = COALESCE(v_payload->'authority_ack_payload', authority_ack_payload),
         rejection_reasons = CASE
           WHEN v_payload ? 'rejection_reasons' THEN v_payload->'rejection_reasons'
           ELSE rejection_reasons
         END,
         updated_at = now()
   WHERE id = _run_id
   RETURNING * INTO v_run;

  INSERT INTO public.pack_return_run_audit
    (run_id, organization_id, business_id, from_status, to_status, actor_user_id, reason, payload)
  VALUES
    (v_run.id, v_run.organization_id, v_run.business_id, v_prev, _to_status, v_actor, _reason, v_payload);

  RETURN v_run;
END;
$$;

UPDATE public.payroll_return_runs
   SET csv_path = regexp_replace(csv_path, '^payroll/statutory-returns/([0-9a-fA-F-]{36})/', '\1/payroll/statutory-returns/'),
       pdf_path = regexp_replace(pdf_path, '^payroll/statutory-returns/([0-9a-fA-F-]{36})/', '\1/payroll/statutory-returns/'),
       gov_file_path = regexp_replace(gov_file_path, '^payroll/statutory-returns/([0-9a-fA-F-]{36})/', '\1/payroll/statutory-returns/'),
       updated_at = now()
 WHERE csv_path LIKE 'payroll/statutory-returns/%'
    OR pdf_path LIKE 'payroll/statutory-returns/%'
    OR gov_file_path LIKE 'payroll/statutory-returns/%';