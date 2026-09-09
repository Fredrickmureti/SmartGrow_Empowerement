CREATE OR REPLACE FUNCTION public.mf_reverse_fee_collection(
  p_collection_id uuid,
  p_reason text DEFAULT NULL,
  p_effective_on date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  col public.mf_fee_collections%ROWTYPE;
  v_je uuid;
BEGIN
  SELECT * INTO col FROM public.mf_fee_collections WHERE id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That collection does not exist.';
  END IF;
  IF NOT public.mf_can(col.business_id, col.branch_id, 'repayments', 'write') THEN
    RAISE EXCEPTION 'You do not have permission to perform this action.';
  END IF;
  IF col.status = 'reversed' THEN
    RAISE EXCEPTION 'This collection has already been reversed.';
  END IF;

  IF col.journal_entry_id IS NOT NULL THEN
    v_je := public.void_journal_entry_atomic(
      col.journal_entry_id,
      format('Reversal of group fee collection %s', col.collection_number),
      auth.uid(),
      NULL,
      COALESCE(p_effective_on, col.collected_on, CURRENT_DATE));
  END IF;

  UPDATE public.mf_client_charge_payments
     SET status = 'reversed',
         reversal_journal_entry_id = v_je,
         reversed_at = now(),
         reversal_reason = p_reason
   WHERE collection_id = col.id AND status = 'posted';

  UPDATE public.mf_fee_collections
     SET status = 'reversed',
         reversal_journal_entry_id = v_je,
         reversed_at = now(),
         reversed_by = auth.uid(),
         reversal_reason = p_reason
   WHERE id = col.id;

  RETURN v_je;
END;
$function$;

REVOKE ALL ON FUNCTION public.mf_reverse_fee_collection(uuid, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mf_reverse_fee_collection(uuid, text, date) TO authenticated;