CREATE OR REPLACE FUNCTION public.mf_close_loan(
  p_loan_id uuid,
  p_closed_on date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL
) RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l public.mf_loans%ROWTYPE;
  v_outstanding numeric;
  v_ev uuid;
BEGIN
  SELECT * INTO l FROM public.mf_loans WHERE id = p_loan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF NOT user_has_business_access(auth.uid(), l.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'accountant')) THEN
    RAISE EXCEPTION 'You are not authorised to close loans';
  END IF;
  IF l.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active loan can be closed (loan is %)', l.status;
  END IF;

  SELECT COALESCE(total_outstanding, 0) INTO v_outstanding
    FROM public.mf_loan_balances WHERE loan_id = p_loan_id;
  IF ROUND(COALESCE(v_outstanding, 0), 2) > 0 THEN
    RAISE EXCEPTION 'Loan still has % outstanding and cannot be closed', ROUND(v_outstanding, 2);
  END IF;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (l.business_id, l.id, 'loan_closed', auth.uid(), 0,
          jsonb_build_object('closed_on', p_closed_on, 'notes', p_notes))
  RETURNING id INTO v_ev;

  UPDATE public.mf_loans
     SET status = 'closed', closed_at = now(), updated_at = now()
   WHERE id = l.id;

  RETURN v_ev;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_close_loan(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_close_loan(uuid, date, text) TO authenticated;