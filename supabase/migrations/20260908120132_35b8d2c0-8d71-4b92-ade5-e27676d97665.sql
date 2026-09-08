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
  v_je uuid;
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

  IF ch.status = 'paid' THEN
    IF ch.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'This payment was never posted; nothing to reverse.';
    END IF;
    v_je := public.void_journal_entry_atomic(
      ch.journal_entry_id,
      format('Reversal of admission fee receipt %s', COALESCE(ch.receipt_number, '')),
      auth.uid(),
      NULL,
      COALESCE(p_effective_on, ch.paid_on, CURRENT_DATE));
  END IF;

  UPDATE public.mf_client_charges
     SET status = 'reversed',
         reversal_journal_entry_id = v_je,
         reversed_at = now(),
         reversal_reason = p_reason
   WHERE id = ch.id;

  RETURN v_je;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_reverse_client_charge(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_reverse_client_charge(uuid, text, date) TO authenticated;