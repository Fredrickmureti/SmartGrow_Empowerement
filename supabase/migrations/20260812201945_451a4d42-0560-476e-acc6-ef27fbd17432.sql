CREATE OR REPLACE FUNCTION public.preview_reversal_extras_customer_refund(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          public.customer_refunds%ROWTYPE;
  v_money    jsonb := '[]'::jsonb;
  v_docs     jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_bank     text;
BEGIN
  SELECT * INTO r FROM public.customer_refunds WHERE id = _document_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
  END IF;

  SELECT ba.name INTO v_bank
    FROM public.bank_accounts ba
   WHERE ba.id = r.bank_account_id;

  v_money := jsonb_build_array(jsonb_build_object(
    'payment_id',       _document_id,
    'receipt_number',   'Refund from ' || COALESCE(v_bank, 'bank account'),
    'allocated_amount', COALESCE(r.amount, 0),
    'bank_reconciled',  false));

  v_docs := jsonb_build_array(
    jsonb_build_object('kind', 'payment', 'label', 'Customer receipt refunded',
                       'count', CASE WHEN r.source_payment_id IS NULL THEN 0 ELSE 1 END),
    jsonb_build_object('kind', 'credit_note', 'label', 'Credit note drawn down',
                       'count', CASE WHEN r.source_credit_note_id IS NULL THEN 0 ELSE 1 END));

  v_warnings := v_warnings || jsonb_build_object(
    'code', 'refund_cash_already_left',
    'severity', 'warning',
    'message', 'The refunded money has already left the bank. Reversing this record does not recall the funds — record a customer receipt when the money comes back.');

  RETURN jsonb_build_object('money', v_money, 'related_documents', v_docs, 'warnings', v_warnings);
END $function$;

NOTIFY pgrst, 'reload schema';