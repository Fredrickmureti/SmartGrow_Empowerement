CREATE OR REPLACE FUNCTION public.mf_pay_client_charge(
  p_charge_id uuid,
  p_paid_on date DEFAULT NULL,
  p_method text DEFAULT 'cash',
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
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
  v_prefix text;
  v_seq bigint;
  v_attempt integer := 0;
  v_receipt text;
  v_desc text;
  v_lines jsonb;
  v_je uuid;
BEGIN
  SELECT * INTO ch FROM public.mf_client_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That charge does not exist.';
  END IF;
  IF NOT public.mf_can(ch.business_id, ch.branch_id, 'repayments', 'create') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF ch.status <> 'outstanding' THEN
    RAISE EXCEPTION 'This charge is already %.', ch.status;
  END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference) <> '' AND EXISTS (
       SELECT 1 FROM public.mf_client_charges
        WHERE business_id = ch.business_id AND reference = p_reference AND status = 'paid') THEN
    RAISE EXCEPTION 'A charge payment with reference % has already been recorded.', p_reference;
  END IF;

  SELECT * INTO c FROM public.mf_clients WHERE id = ch.client_id;
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = ch.business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Institution % has no organization', ch.business_id;
  END IF;

  v_prefix := 'ADM-' || to_char(v_paid_on, 'YYYYMM') || '-';
  LOOP
    v_attempt := v_attempt + 1;
    SELECT COALESCE(MAX(NULLIF(regexp_replace(right(receipt_number, 5), '\D', '', 'g'), '')::bigint), 0) + v_attempt
      INTO v_seq
      FROM public.mf_client_charges
     WHERE business_id = ch.business_id AND receipt_number LIKE v_prefix || '%';
    v_receipt := v_prefix || lpad(v_seq::text, 5, '0');
    BEGIN
      UPDATE public.mf_client_charges
         SET receipt_number = v_receipt
       WHERE id = ch.id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 25 THEN RAISE; END IF;
    END;
  END LOOP;

  v_desc := format('Client admission fee %s receipt %s', c.client_number, v_receipt);
  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', public.mf_resolve_account(ch.business_id, ch.branch_id,
                       public.mf_method_mapping_key(COALESCE(p_method, 'cash'))),
      'debit', ch.amount, 'credit', 0, 'description', v_desc),
    jsonb_build_object(
      'account_id', public.mf_resolve_account(ch.business_id, ch.branch_id, 'fee_income'),
      'debit', 0, 'credit', ch.amount, 'description', v_desc || ' - fee income'));

  v_je := public.post_journal_entry_atomic(
    _org_id         => v_org,
    _business_id    => ch.business_id,
    _entry_number   => NULL,
    _entry_date     => v_paid_on,
    _reference      => COALESCE(NULLIF(btrim(p_reference), ''), v_receipt),
    _description    => v_desc,
    _source_type    => 'mf_client_charge',
    _source_id      => ch.id,
    _created_by     => auth.uid(),
    _is_closing     => false,
    _is_adjusting   => false,
    _lines          => v_lines,
    _currency       => ch.currency_code,
    _exchange_rate  => 1::numeric,
    _source_subtype => ch.kind,
    _branch_id      => ch.branch_id,
    _is_opening_entry => false,
    _amounts_in_document_currency => false);

  UPDATE public.mf_client_charges
     SET status = 'paid',
         paid_on = v_paid_on,
         method = COALESCE(p_method, 'cash'),
         reference = NULLIF(btrim(p_reference), ''),
         notes = COALESCE(p_notes, notes),
         journal_entry_id = v_je
   WHERE id = ch.id;

  RETURN ch.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_pay_client_charge(uuid, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_pay_client_charge(uuid, date, text, text, text) TO authenticated;