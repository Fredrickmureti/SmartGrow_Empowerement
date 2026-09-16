CREATE OR REPLACE FUNCTION public.mf_attach_disbursement_photo(p_disbursement_id uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  d public.mf_loan_disbursements%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.mf_loan_disbursements WHERE id = p_disbursement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Disbursement not found'; END IF;

  IF NOT user_has_business_access(auth.uid(), d.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this institution';
  END IF;
  IF NOT (has_role(auth.uid(),'admin')
       OR has_role(auth.uid(),'branch_manager') OR has_role(auth.uid(),'cashier')) THEN
    RAISE EXCEPTION 'You are not authorised to attach a payout photo';
  END IF;
  IF d.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This disbursement was reversed';
  END IF;
  IF d.payout_photo_path IS NOT NULL THEN
    RAISE EXCEPTION 'A payout photo is already attached to this disbursement';
  END IF;
  IF p_path IS NULL OR p_path NOT LIKE (d.business_id::text || '/' || d.loan_id::text || '/%') THEN
    RAISE EXCEPTION 'The photo is not filed under this loan';
  END IF;

  UPDATE public.mf_loan_disbursements
     SET payout_photo_path = p_path, updated_at = now()
   WHERE id = d.id;

  INSERT INTO public.mf_loan_events (business_id, loan_id, event_type, actor_id, amount, payload)
  VALUES (d.business_id, d.loan_id, 'disbursement_photo_attached', auth.uid(), NULL,
          jsonb_build_object('disbursement_id', d.id, 'path', p_path));
END; $function$;

REVOKE ALL ON FUNCTION public.mf_attach_disbursement_photo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_attach_disbursement_photo(uuid, text) TO authenticated;