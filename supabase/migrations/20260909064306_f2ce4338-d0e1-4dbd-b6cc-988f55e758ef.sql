CREATE OR REPLACE FUNCTION public.mf_reverse_client_charge_payment(
  p_payment_id uuid,
  p_reason text DEFAULT NULL,
  p_effective_on date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  pay public.mf_client_charge_payments%ROWTYPE;
  v_je uuid;
BEGIN
  SELECT * INTO pay FROM public.mf_client_charge_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That fee payment does not exist.';
  END IF;
  IF NOT public.mf_can(pay.business_id, pay.branch_id, 'repayments', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF pay.status = 'reversed' THEN
    RAISE EXCEPTION 'This fee payment has already been reversed.';
  END IF;
  IF pay.collection_id IS NOT NULL THEN
    RAISE EXCEPTION 'This payment was taken in a group collection. Reverse the collection instead.';
  END IF;

  IF pay.journal_entry_id IS NOT NULL THEN
    v_je := public.void_journal_entry_atomic(
      pay.journal_entry_id,
      format('Reversal of admission fee receipt %s', COALESCE(pay.receipt_number, '')),
      auth.uid(),
      NULL,
      COALESCE(p_effective_on, pay.paid_on, CURRENT_DATE));
  END IF;

  UPDATE public.mf_client_charge_payments
     SET status = 'reversed',
         reversal_journal_entry_id = v_je,
         reversed_at = now(),
         reversal_reason = p_reason
   WHERE id = pay.id;

  RETURN v_je;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_reverse_client_charge_payment(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_reverse_client_charge_payment(uuid, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.mf_reverse_client_charge(
  p_charge_id uuid,
  p_reason text DEFAULT NULL,
  p_effective_on date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ch public.mf_client_charges%ROWTYPE;
  pay public.mf_client_charge_payments%ROWTYPE;
  v_last uuid;
BEGIN
  SELECT * INTO ch FROM public.mf_client_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That charge does not exist.';
  END IF;
  IF NOT public.mf_can(ch.business_id, ch.branch_id, 'repayments', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF ch.status = 'reversed' THEN
    RAISE EXCEPTION 'This charge has already been reversed.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.mf_client_charge_payments
              WHERE charge_id = ch.id AND status = 'posted' AND collection_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Part of this fee was collected with a group. Reverse that collection first.';
  END IF;

  FOR pay IN SELECT * FROM public.mf_client_charge_payments
              WHERE charge_id = ch.id AND status = 'posted'
  LOOP
    v_last := public.mf_reverse_client_charge_payment(pay.id, p_reason, p_effective_on);
  END LOOP;

  UPDATE public.mf_client_charges
     SET status = 'reversed',
         reversal_journal_entry_id = v_last,
         reversed_at = now(),
         reversal_reason = p_reason
   WHERE id = ch.id;

  RETURN v_last;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_reverse_client_charge(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_reverse_client_charge(uuid, text, date) TO authenticated;