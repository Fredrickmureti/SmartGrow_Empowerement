DROP FUNCTION IF EXISTS public.mf_pay_client_charge(uuid, date, text, text, text);

CREATE OR REPLACE FUNCTION public.mf_pay_client_charge(
  p_charge_id uuid,
  p_paid_on date DEFAULT NULL,
  p_method text DEFAULT 'cash',
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_amount numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ch public.mf_client_charges%ROWTYPE;
  c public.mf_clients%ROWTYPE;
  v_org uuid;
  v_paid_on date := COALESCE(p_paid_on, CURRENT_DATE);
  v_outstanding numeric(18,2);
  v_amount numeric(18,2);
  v_receipt text;
  v_attempt integer := 0;
  v_desc text;
  v_je uuid;
  v_payment uuid;
BEGIN
  SELECT * INTO ch FROM public.mf_client_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That charge does not exist.';
  END IF;
  IF NOT public.mf_can(ch.business_id, ch.branch_id, 'repayments', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF ch.status = 'reversed' THEN
    RAISE EXCEPTION 'This charge has been reversed.';
  END IF;

  v_outstanding := ROUND(ch.amount - COALESCE(ch.paid_amount, 0), 2);
  IF v_outstanding <= 0 THEN
    RAISE EXCEPTION 'This charge is already settled in full.';
  END IF;

  v_amount := ROUND(COALESCE(p_amount, v_outstanding), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.';
  END IF;
  IF v_amount > v_outstanding THEN
    RAISE EXCEPTION 'That is more than the % outstanding on this fee.', v_outstanding;
  END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference) <> '' AND EXISTS (
       SELECT 1 FROM public.mf_client_charge_payments
        WHERE business_id = ch.business_id AND reference = btrim(p_reference) AND status = 'posted') THEN
    RAISE EXCEPTION 'A fee payment with reference % has already been recorded.', p_reference;
  END IF;

  SELECT * INTO c FROM public.mf_clients WHERE id = ch.client_id;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = ch.business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Institution % has no organization', ch.business_id;
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_receipt := public.mf_next_fee_receipt_number(ch.business_id, v_paid_on, v_attempt);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.mf_client_charge_payments
       WHERE business_id = ch.business_id AND receipt_number = v_receipt)
      AND NOT EXISTS (
      SELECT 1 FROM public.mf_client_charges
       WHERE business_id = ch.business_id AND receipt_number = v_receipt);
    IF v_attempt >= 50 THEN
      RAISE EXCEPTION 'Could not allocate a receipt number.';
    END IF;
  END LOOP;

  v_desc := format('Client admission fee %s receipt %s', c.client_number, v_receipt);

  v_je := public.post_journal_entry_atomic(
    _org_id       => v_org,
    _business_id  => ch.business_id,
    _entry_number => NULL,
    _entry_date   => v_paid_on,
    _reference    => COALESCE(NULLIF(btrim(p_reference), ''), v_receipt),
    _description  => v_desc,
    _source_type  => 'mf_client_charge',
    _source_id    => ch.id,
    _created_by   => auth.uid(),
    _is_closing   => false,
    _is_adjusting => false,
    _lines        => jsonb_build_array(
      jsonb_build_object(
        'account_id', public.mf_resolve_account(ch.business_id, ch.branch_id,
                        public.mf_method_mapping_key(COALESCE(p_method, 'cash'))),
        'debit', v_amount, 'credit', 0, 'description', v_desc),
      jsonb_build_object(
        'account_id', public.mf_resolve_account(ch.business_id, ch.branch_id, 'fee_income'),
        'debit', 0, 'credit', v_amount, 'description', v_desc || ' - fee income')));

  INSERT INTO public.mf_client_charge_payments (
    business_id, branch_id, charge_id, client_id, collection_id, amount, paid_on,
    method, reference, receipt_number, status, journal_entry_id, notes, created_by
  ) VALUES (
    ch.business_id, ch.branch_id, ch.id, ch.client_id, NULL, v_amount, v_paid_on,
    COALESCE(p_method, 'cash'), NULLIF(btrim(p_reference), ''), v_receipt, 'posted',
    v_je, p_notes, auth.uid()
  ) RETURNING id INTO v_payment;

  RETURN v_payment;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_pay_client_charge(uuid, date, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_pay_client_charge(uuid, date, text, text, text, numeric) TO authenticated;