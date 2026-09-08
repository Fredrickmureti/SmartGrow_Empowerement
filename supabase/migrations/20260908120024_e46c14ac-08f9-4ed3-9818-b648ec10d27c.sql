CREATE OR REPLACE FUNCTION public.mf_raise_client_admission_fee(
  p_client_id uuid,
  p_charged_on date DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c public.mf_clients%ROWTYPE;
  pol public.mf_client_fee_policy%ROWTYPE;
  v_currency text;
  v_id uuid;
BEGIN
  SELECT * INTO c FROM public.mf_clients WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That client does not exist.';
  END IF;
  IF NOT public.mf_can(c.business_id, c.branch_id, 'repayments', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;

  SELECT * INTO pol FROM public.mf_client_fee_policy WHERE business_id = c.business_id;
  IF NOT FOUND OR NOT pol.admission_fee_active
     OR pol.admission_fee_amount IS NULL OR pol.admission_fee_amount <= 0 THEN
    RAISE EXCEPTION 'No admission fee is configured. Set it under Lending → Configuration → Accounting.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_client_charges
              WHERE client_id = p_client_id AND kind = 'admission_fee' AND status <> 'reversed') THEN
    RAISE EXCEPTION 'This client already has an admission fee on record.';
  END IF;

  v_currency := COALESCE(
    NULLIF(btrim(pol.admission_fee_currency), ''),
    (SELECT b.base_currency FROM public.businesses b WHERE b.id = c.business_id));
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'The institution has no currency configured.';
  END IF;

  INSERT INTO public.mf_client_charges (
    business_id, branch_id, client_id, kind, charged_on, amount, currency_code,
    status, notes, created_by
  ) VALUES (
    c.business_id, c.branch_id, c.id, 'admission_fee',
    COALESCE(p_charged_on, CURRENT_DATE),
    ROUND(pol.admission_fee_amount, 2), v_currency,
    'outstanding', p_notes, auth.uid()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_raise_client_admission_fee(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_raise_client_admission_fee(uuid, date, text) TO authenticated;