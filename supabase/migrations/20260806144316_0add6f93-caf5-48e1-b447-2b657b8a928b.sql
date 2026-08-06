CREATE OR REPLACE FUNCTION public.void_invoice_atomic(
  _invoice_id uuid,
  _reason text,
  _void_date date DEFAULT NULL,
  _actor uuid DEFAULT NULL,
  _cascade_payments boolean DEFAULT true,
  _client_request_id text DEFAULT NULL
) RETURNS jsonb
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
  v_payment_ids  uuid[] := ARRAY[]::uuid[];
  v_payment_id   uuid;
  v_voided_pmts  uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found.', _invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.status::text IN ('voided', 'cancelled') THEN
    RETURN jsonb_build_object('invoice_id', _invoice_id, 'already_voided', true);
  END IF;

  v_date := COALESCE(_void_date, CURRENT_DATE);

  IF v_inv.business_id IS NOT NULL
     AND NOT public.is_period_open(v_inv.business_id, v_date) THEN
    RAISE EXCEPTION 'Void date falls in a closed fiscal period. Void refused.' USING ERRCODE = '22023';
  END IF;

  v_label := 'Void invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
             || ': ' || COALESCE(_reason, 'no reason given');

  -- Live payments touching this invoice, discovered through the allocation
  -- ledger (ADR 0027), never the deprecated single-invoice FK.
  SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_payment_ids
    FROM public.payment_allocations a
    JOIN public.payments p ON p.id = a.payment_id
   WHERE a.invoice_id = _invoice_id
     AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

  IF array_length(v_payment_ids, 1) > 0 AND NOT _cascade_payments THEN
    RAISE EXCEPTION 'Invoice % still has % live payment(s). Void or unapply them first, or request a cascading void.',
      COALESCE(v_inv.invoice_number, _invoice_id::text), array_length(v_payment_ids, 1)
      USING ERRCODE = '23514';
  END IF;

  -- 1. GL first: reverse every live entry sourced from this invoice
  --    (main plus the COGS sub-entry).
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

  -- 2. Header. Set before the payment cascade so `void_payment_atomic` sees a
  --    voided invoice and does not reopen its status while recomputing.
  UPDATE public.invoices
     SET status                      = 'voided'::invoice_status,
         voided_at                   = now(),
         voided_by                   = _actor,
         void_reason                 = _reason,
         journal_entry_id            = NULL,
         reversal_journal_entry_id   = v_main_rev,
         updated_at                  = now()
   WHERE id = _invoice_id;

  -- 3. Cascade through the canonical AR reversal writer — never a local copy.
  FOREACH v_payment_id IN ARRAY v_payment_ids LOOP
    PERFORM public.void_payment_atomic(
      v_payment_id,
      'Parent invoice ' || COALESCE(v_inv.invoice_number, _invoice_id::text)
        || ' voided: ' || COALESCE(_reason, 'no reason given'),
      'parent_document_voided',
      v_date,
      _actor,
      CASE WHEN _client_request_id IS NULL THEN NULL
           ELSE _client_request_id || ':' || v_payment_id::text END
    );
    v_voided_pmts := v_voided_pmts || v_payment_id;
  END LOOP;

  -- 4. Inventory. Idempotent by contract.
  PERFORM public.restore_invoice_stock_atomic(_invoice_id, _actor, _reason);

  RETURN jsonb_build_object(
    'invoice_id', _invoice_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'main_reversal_journal_entry_id', v_main_rev,
    'voided_payment_ids', to_jsonb(v_voided_pmts)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.void_invoice_atomic(uuid, text, date, uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_invoice_atomic(uuid, text, date, uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_invoice_atomic(uuid, text, date, uuid, boolean, text) TO service_role;