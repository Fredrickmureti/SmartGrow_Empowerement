-- =====================================================================
-- Phase 4 — Warehouse tasks & bank reconciliation participation
-- =====================================================================

-- ---------------------------------------------------------------- WMS read
CREATE OR REPLACE FUNCTION public.wms_open_tasks_for_document(
  _source_doc_type text,
  _source_doc_id   uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'task_id',       t.id,
           'task_type',     t.task_type::text,
           'state',         t.state::text,
           'warehouse_id',  t.warehouse_id,
           'product_id',    t.product_id,
           'quantity',      t.quantity,
           'assignee_user_id', t.assignee_user_id
         ) ORDER BY t.created_at), '[]'::jsonb)
    FROM public.wms_tasks t
   WHERE t.source_doc_type = _source_doc_type
     AND t.source_doc_id   = _source_doc_id
     AND t.state::text IN ('pending','available','claimed','in_progress','paused','resumed','exception');
$$;

REVOKE ALL ON FUNCTION public.wms_open_tasks_for_document(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_open_tasks_for_document(text, uuid) TO authenticated;

-- --------------------------------------------------------------- WMS writer
-- Canonical single writer for document-driven task cancellation. Reversal
-- orchestrators call this participant; application code never flips
-- wms_tasks.state to 'cancelled' by itself.
CREATE OR REPLACE FUNCTION public.wms_cancel_tasks_for_document(
  _source_doc_type text,
  _source_doc_id   uuid,
  _reason          text DEFAULT NULL,
  _actor           uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
BEGIN
  UPDATE public.wms_tasks t
     SET state         = 'cancelled'::wms_task_state,
         cancel_reason = COALESCE(_reason, 'Source document reversed'),
         completed_at  = COALESCE(t.completed_at, now()),
         claimed_by    = NULL,
         claimed_at    = NULL,
         expires_at    = NULL,
         updated_at    = now()
   WHERE t.source_doc_type = _source_doc_type
     AND t.source_doc_id   = _source_doc_id
     AND t.state::text IN ('pending','available','claimed','in_progress','paused','resumed','exception');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.wms_cancel_tasks_for_document(text, uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_cancel_tasks_for_document(text, uuid, text, uuid) TO authenticated;

-- ------------------------------------------------------- bank lines (read)
CREATE OR REPLACE FUNCTION public.reversal_bank_lines(
  _document_type text,
  _document_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_ids uuid[] := ARRAY[]::uuid[];
  v_kind        text;
  v_lines       jsonb := '[]'::jsonb;
BEGIN
  IF _document_type = 'payment' THEN
    v_kind := 'payment';
    v_payment_ids := ARRAY[_document_id];
  ELSIF _document_type = 'bill_payment' THEN
    v_kind := 'bill_payment';
    v_payment_ids := ARRAY[_document_id];
  ELSIF _document_type = 'invoice' THEN
    v_kind := 'payment';
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
      INTO v_payment_ids
      FROM public.payment_allocations a
      JOIN public.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = _document_id
       AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');
  ELSIF _document_type = 'bill' THEN
    v_kind := 'bill_payment';
    SELECT COALESCE(array_agg(DISTINCT bp.id), ARRAY[]::uuid[])
      INTO v_payment_ids
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = _document_id
       AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');
  ELSE
    RETURN '[]'::jsonb;
  END IF;

  IF array_length(v_payment_ids, 1) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bank_transaction_id', bt.id,
           'bank_account_id',     bt.bank_account_id,
           'transaction_date',    bt.transaction_date,
           'description',         bt.description,
           'amount',              bt.amount,
           'reconciled_type',     bt.reconciled_type,
           'payment_id',          COALESCE(bt.reconciled_payment_id, bt.reconciled_entity_id),
           'payment_kind',        v_kind
         ) ORDER BY bt.transaction_date), '[]'::jsonb)
    INTO v_lines
    FROM public.bank_transactions bt
   WHERE COALESCE(bt.is_reconciled, false)
     AND (
       (v_kind = 'payment'
         AND (bt.reconciled_payment_id = ANY(v_payment_ids)
           OR (bt.reconciled_type = 'payment' AND bt.reconciled_entity_id = ANY(v_payment_ids))))
       OR (v_kind = 'bill_payment'
         AND bt.reconciled_type = 'bill_payment'
         AND bt.reconciled_entity_id = ANY(v_payment_ids))
     );

  RETURN v_lines;
END;
$$;

REVOKE ALL ON FUNCTION public.reversal_bank_lines(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reversal_bank_lines(text, uuid) TO authenticated;

-- ------------------------------- unreconcile: AP branch (bill_payment)
CREATE OR REPLACE FUNCTION public.unreconcile_bank_transaction(
  _bank_transaction_id uuid,
  _reason text DEFAULT NULL::text,
  _user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _txn record;
  _writeoff record;
  _reversed_matches integer := 0;
  _reversed_writeoffs integer := 0;
  _voided_entries integer := 0;
BEGIN
  SELECT * INTO _txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF _txn.id IS NULL THEN
    RAISE EXCEPTION 'Bank transaction % not found', _bank_transaction_id;
  END IF;

  -- Phase 13: server-side permission gate
  PERFORM public.assert_can_reconcile_bank(_txn.business_id);

  IF _txn.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      _txn.journal_entry_id,
      COALESCE(_reason, 'Bank transaction unreconciled'),
      _user_id,
      NULL,
      COALESCE(_txn.transaction_date, CURRENT_DATE)
    );
    _voided_entries := _voided_entries + 1;
  END IF;

  FOR _writeoff IN
    SELECT w.*
    FROM public.bank_reconciliation_writeoffs w
    JOIN public.bank_reconciliation_matches m ON m.id = w.reconciliation_match_id
    WHERE m.bank_transaction_id = _bank_transaction_id
      AND w.status IN ('draft','posted')
  LOOP
    IF _writeoff.journal_entry_id IS NOT NULL THEN
      PERFORM public.void_journal_entry_atomic(
        _writeoff.journal_entry_id,
        COALESCE(_reason, 'Bank reconciliation write-off unreconciled'),
        _user_id,
        COALESCE(_txn.transaction_date, CURRENT_DATE)
      );
      _voided_entries := _voided_entries + 1;
    END IF;
  END LOOP;

  UPDATE public.bank_reconciliation_writeoffs w
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         updated_at = now()
    FROM public.bank_reconciliation_matches m
   WHERE w.reconciliation_match_id = m.id
     AND m.bank_transaction_id = _bank_transaction_id
     AND w.status IN ('draft','posted');
  GET DIAGNOSTICS _reversed_writeoffs = ROW_COUNT;

  UPDATE public.bank_reconciliation_matches
     SET status = 'reversed',
         reversed_by = _user_id,
         reversed_at = now(),
         notes = trim(both from concat_ws(' | ', notes, 'Unreconciled: ' || COALESCE(_reason, 'No reason provided'))),
         updated_at = now()
   WHERE bank_transaction_id = _bank_transaction_id
     AND status IN ('suggested','to_check','confirmed');
  GET DIAGNOSTICS _reversed_matches = ROW_COUNT;

  IF _txn.reconciled_type = 'invoice' AND _txn.reconciled_payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET status = 'unreconciled',
           unreconciled_at = now(),
           unreconciled_by = _user_id,
           unreconcile_reason = COALESCE(_reason, 'Bank transaction unreconciled')
     WHERE id = _txn.reconciled_payment_id;
  END IF;

  -- Phase 4 (AP): a customer receipt and a supplier payment must behave
  -- identically. Release the AR payment matched by reconciled_type='payment'
  -- and the AP payment matched by reconciled_type='bill_payment', so the
  -- reversal intent policy stops reporting a bank_reconciled blocker.
  IF _txn.reconciled_type = 'payment' AND COALESCE(_txn.reconciled_payment_id, _txn.reconciled_entity_id) IS NOT NULL THEN
    UPDATE public.payments
       SET status = 'unreconciled',
           unreconciled_at = now(),
           unreconciled_by = _user_id,
           unreconcile_reason = COALESCE(_reason, 'Bank transaction unreconciled')
     WHERE id = COALESCE(_txn.reconciled_payment_id, _txn.reconciled_entity_id);
  END IF;

  IF _txn.reconciled_type = 'bill_payment' AND _txn.reconciled_entity_id IS NOT NULL THEN
    UPDATE public.bill_payments
       SET updated_at = now()
     WHERE id = _txn.reconciled_entity_id;

    UPDATE public.bank_reconciliation_matches
       SET status = 'reversed',
           reversed_by = _user_id,
           reversed_at = now(),
           updated_at = now()
     WHERE matched_entity_type = 'bill_payment'
       AND matched_entity_id = _txn.reconciled_entity_id
       AND COALESCE(status, 'matched') NOT IN ('rejected','unmatched','cancelled','reversed');
  END IF;

  UPDATE public.bank_transactions
     SET is_reconciled = false,
         reconciled_type = NULL,
         reconciled_entity_id = NULL,
         reconciled_at = NULL,
         reconciled_by = NULL,
         journal_entry_id = NULL,
         reconciled_payment_id = NULL,
         match_confidence = NULL,
         match_source = 'unreconciled',
         lifecycle_status = 'for_review',
         updated_at = now()
   WHERE id = _bank_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'reversed_matches', _reversed_matches,
    'reversed_writeoffs', _reversed_writeoffs,
    'voided_entries', _voided_entries
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.unreconcile_bank_transaction(uuid, text, uuid) TO authenticated;

-- --------------------------- guided resolution of the bank_reconciled block
CREATE OR REPLACE FUNCTION public.resolve_reversal_bank_block(
  _document_type text,
  _document_id   uuid,
  _reason        text DEFAULT NULL,
  _actor         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lines jsonb;
  v_line  jsonb;
  v_ids   uuid[] := ARRAY[]::uuid[];
BEGIN
  v_lines := public.reversal_bank_lines(_document_type, _document_id);

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    PERFORM public.unreconcile_bank_transaction(
      (v_line->>'bank_transaction_id')::uuid,
      COALESCE(_reason, 'Un-matched to allow reversal of ' || _document_type),
      _actor
    );
    v_ids := v_ids || (v_line->>'bank_transaction_id')::uuid;
  END LOOP;

  RETURN jsonb_build_object(
    'document_type', _document_type,
    'document_id',   _document_id,
    'unreconciled_bank_transaction_ids', to_jsonb(v_ids),
    'unreconciled_count', COALESCE(array_length(v_ids, 1), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_reversal_bank_block(text, uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_bank_block(text, uuid, text, uuid) TO authenticated;
