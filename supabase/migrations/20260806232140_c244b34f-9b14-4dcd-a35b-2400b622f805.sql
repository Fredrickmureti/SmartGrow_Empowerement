CREATE OR REPLACE FUNCTION public.get_document_settlement_lineage(p_doc_type text, p_doc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_business uuid;
  v_total numeric;
  v_paid numeric;
  v_due date;
  v_status text;
  v_currency text;
  v_payments jsonb;
  v_je jsonb;
  v_recon jsonb;
  v_credit_notes jsonb;
  v_returns jsonb;
  v_balance numeric;
BEGIN
  IF p_doc_type <> 'invoice' THEN
    RETURN jsonb_build_object('error', 'unsupported doc_type');
  END IF;

  SELECT organization_id, business_id, COALESCE(total, 0), COALESCE(amount_paid, 0),
         due_date, status::text, currency
    INTO v_org, v_business, v_total, v_paid, v_due, v_status, v_currency
    FROM public.invoices WHERE id = p_doc_id;

  IF v_business IS NULL OR NOT public.user_can_access_business(auth.uid(), v_business) THEN
    RETURN jsonb_build_object('error', 'access denied');
  END IF;

  -- Customer payments allocated to this invoice (voided payments excluded)
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'date' DESC), '[]'::jsonb) INTO v_payments
  FROM (
    SELECT jsonb_build_object(
             'id', p.id,
             'number', p.receipt_number,
             'status', p.status,
             'date', pa.created_at::date,
             'amount', pa.amount
           ) AS x
    FROM public.payment_allocations pa
    JOIN public.payments p ON p.id = pa.payment_id
    WHERE pa.invoice_id = p_doc_id
      AND COALESCE(p.status, 'completed') <> 'voided'
  ) s;

  -- Posted journal entry for the invoice
  SELECT jsonb_build_object(
           'id', je.id, 'number', je.entry_number,
           'status', je.status, 'date', je.entry_date
         ) INTO v_je
    FROM public.journal_entries je
   WHERE je.source_type = 'invoice' AND je.source_id = p_doc_id
     AND COALESCE(je.status, '') <> 'voided'
   ORDER BY je.created_at DESC
   LIMIT 1;

  -- Bank reconciliation state of the settling payments
  SELECT jsonb_build_object(
           'matched', COUNT(*) FILTER (WHERE m.status = 'confirmed'),
           'pending', COUNT(*) FILTER (WHERE m.status <> 'confirmed')
         ) INTO v_recon
    FROM public.bank_reconciliation_matches m
   WHERE m.reversed_at IS NULL
     AND m.matched_payment_id IN (
       SELECT pa.payment_id FROM public.payment_allocations pa WHERE pa.invoice_id = p_doc_id
     );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', cn.id, 'number', cn.credit_note_number,
           'status', cn.status::text, 'date', cn.issue_date, 'amount', cn.total
         ) ORDER BY cn.issue_date DESC), '[]'::jsonb) INTO v_credit_notes
    FROM public.credit_notes cn
   WHERE cn.invoice_id = p_doc_id OR cn.original_invoice_id = p_doc_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id, 'number', r.return_number,
           'status', r.status::text, 'date', r.return_date, 'amount', r.total
         ) ORDER BY r.return_date DESC), '[]'::jsonb) INTO v_returns
    FROM public.sales_returns r
   WHERE r.invoice_id = p_doc_id;

  v_balance := GREATEST(v_total - v_paid, 0);

  RETURN jsonb_build_object(
    'payments', v_payments,
    'journal_entry', v_je,
    'reconciliation', COALESCE(v_recon, jsonb_build_object('matched', 0, 'pending', 0)),
    'credit_notes', v_credit_notes,
    'returns', v_returns,
    'collections', jsonb_build_object(
      'balance', v_balance,
      'currency', v_currency,
      'due_date', v_due,
      'days_overdue', CASE
        WHEN v_balance > 0 AND v_due IS NOT NULL AND v_due < CURRENT_DATE
          THEN (CURRENT_DATE - v_due)
        ELSE 0 END,
      'status', v_status
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_document_settlement_lineage(text, uuid) TO authenticated;