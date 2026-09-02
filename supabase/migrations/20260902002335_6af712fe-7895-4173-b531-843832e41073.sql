CREATE OR REPLACE FUNCTION public.mf_write_off_loan(
  p_loan_id uuid,
  p_written_off_on date,
  p_reason text
) RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  b record;
  v_ev uuid;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'accountant')) THEN
    RAISE EXCEPTION 'You are not authorised to write off loans';
  END IF;
  IF l.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active loan can be written off (loan is %)', l.status;
  END IF;
  IF COALESCE(BTRIM(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A write-off reason is required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mf_loan_events
              WHERE loan_id = p_loan_id AND event_type = 'loan_written_off') THEN
    RAISE EXCEPTION 'This loan has already been written off';
  END IF;

  SELECT principal_outstanding, interest_outstanding, fees_outstanding, total_outstanding
    INTO b
    FROM public.mf_loan_balances WHERE loan_id = p_loan_id;
  IF COALESCE(b.total_outstanding, 0) <= 0 THEN
    RAISE EXCEPTION 'This loan has nothing outstanding to write off';
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'loan_written_off', auth.uid(), b.total_outstanding,
          jsonb_build_object(
            'written_off_on', p_written_off_on,
            'reason', BTRIM(p_reason),
            'principal_written_off', COALESCE(b.principal_outstanding, 0),
            'interest_written_off', COALESCE(b.interest_outstanding, 0) + COALESCE(b.fees_outstanding, 0)))
  RETURNING id INTO v_ev;

  PERFORM public.mf_post_event(v_ev);

  UPDATE public.mf_loans
     SET status = 'written_off', closed_at = now(), updated_at = now()
   WHERE id = l.id;

  RETURN v_ev;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_write_off_loan(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_write_off_loan(uuid, date, text) TO authenticated;