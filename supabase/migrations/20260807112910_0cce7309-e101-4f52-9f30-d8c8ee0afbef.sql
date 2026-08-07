GRANT EXECUTE ON FUNCTION public.wms_open_tasks_for_document(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.wms_cancel_tasks_for_document(text, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reversal_bank_lines(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_bank_block(text, uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences_core(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.void_invoice_atomic(_invoice_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _cascade_payments boolean DEFAULT false, _client_request_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inv          public.invoices%ROWTYPE;
  v_date         date;
  v_label        text;
  v_main_rev     uuid;
  v_je           RECORD;
  v_rev          uuid;
  v_reversals    uuid[] := ARRAY[]::uuid[];
  v_live_count   int := 0;
  v_live_total   numeric := 0;
  v_reconciled   boolean := false;
  v_tasks_cancelled int := 0;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  -- Phase 1: cascading payment voids are retired as an operator-facing power.
  IF COALESCE(_cascade_payments, false) THEN
    RAISE EXCEPTION 'Cascading payment voids are no longer permitted. Voiding an invoice must not unwind a customer payment — issue a credit note, refund the customer, or reverse the payment through the guided wizard. See resolve_reversal_intent(''invoice'', %L).', _invoice_id
      USING ERRCODE = '0A000';
  END IF;

  IF v_inv.business_id IS NOT NULL
     AND NOT public.is_period_open(v_inv.business_id, v_date) THEN
    RAISE EXCEPTION 'Void date % falls in a closed fiscal period. Post a credit note in an open period instead.', v_date
      USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT p.id), COALESCE(SUM(a.amount), 0)
    INTO v_live_count, v_live_total
    FROM public.payment_allocations a
    JOIN public.payments p ON p.id = a.payment_id
   WHERE a.invoice_id = _invoice_id
     AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

  IF v_live_count > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.payment_allocations a
        JOIN public.payments p ON p.id = a.payment_id
       WHERE a.invoice_id = _invoice_id
         AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled')
         AND public.payment_is_bank_reconciled(p.id)
    ) INTO v_reconciled;

    IF v_reconciled THEN
      RAISE EXCEPTION 'Invoice % is settled by a payment matched to a reconciled bank statement. Un-reconcile the bank line first, or issue a credit note / refund.',
        COALESCE(v_inv.invoice_number, _invoice_id::text) USING ERRCODE = '23514';
    END IF;

    RAISE EXCEPTION 'Invoice % is settled by % live payment(s) totalling %. A settled invoice cannot be voided — issue a credit note, refund the customer, or reverse the payment first.',
      COALESCE(v_inv.invoice_number, _invoice_id::text), v_live_count, round(v_live_total, 2)
      USING ERRCODE = '23514';
  END IF;

  v_label := 'Void invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  FOR v_je IN
    SELECT je.id, COALESCE(je.source_subtype, 'main') AS subtype
      FROM public.journal_entries je
     WHERE je.status NOT IN ('voided', 'reversed')
       AND (
         (je.source_type = 'invoice' AND je.source_id = _invoice_id)
         OR je.id = v_inv.journal_entry_id
       )
  LOOP
    v_rev := public.void_journal_entry_atomic(v_je.id, v_label, _actor, NULL, v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
      IF v_je.subtype IN ('main', '') THEN
        v_main_rev := v_rev;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.invoices
     SET status                      = 'voided'::invoice_status,
         voided_at                   = now(),
         voided_by                   = _actor,
         void_reason                 = _reason,
         journal_entry_id            = NULL,
         reversal_journal_entry_id   = v_main_rev,
         updated_at                  = now()
   WHERE id = _invoice_id;

  PERFORM public.restore_invoice_stock_atomic(_invoice_id, _actor, _reason);

  -- Phase 4: the warehouse participates in the reversal. Open picking/packing
  -- work for a voided invoice must not stay on the floor as orphaned tasks.
  v_tasks_cancelled := public.wms_cancel_tasks_for_document(
    'invoice', _invoice_id,
    'Invoice voided: ' || COALESCE(_reason, 'no reason given'), _actor);

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', '[]'::jsonb,
    'cancelled_warehouse_task_count', v_tasks_cancelled
  );
END;
$function$;
