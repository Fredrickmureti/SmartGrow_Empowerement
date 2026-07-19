CREATE OR REPLACE FUNCTION public.trg_pos_transaction_emit_event_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status <> 'completed' THEN RETURN NULL; END IF;
  IF NEW.transaction_type NOT IN ('sale','return') THEN RETURN NULL; END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, 'pos.sale.committed',
    'pos_transaction', NEW.id,
    jsonb_build_object(
      'transaction_id', NEW.id,
      'transaction_number', NEW.transaction_number,
      'transaction_type', NEW.transaction_type,
      'organization_id', NEW.organization_id,
      'business_id', NEW.business_id,
      'branch_id', NEW.branch_id,
      'register_id', NEW.register_id,
      'shift_id', NEW.shift_id,
      'cashier_id', NEW.cashier_id,
      'customer_id', NEW.customer_id,
      'subtotal', NEW.subtotal,
      'tax_amount', NEW.tax_amount,
      'discount_amount', NEW.discount_amount,
      'total', NEW.total,
      'tip_amount', COALESCE(NEW.tip_amount, 0),
      'payment_status', NEW.payment_status,
      'journal_entry_id', NEW.journal_entry_id,
      'completed_at', NEW.completed_at,
      'original_transaction_id', NEW.original_transaction_id
    ),
    'pending',
    'pos.sale.committed:' || NEW.id::text,
    COALESCE(NEW.cashier_id, NEW.created_by),
    'pos'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.trg_pos_payment_emit_event_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_txn RECORD;
BEGIN
  IF COALESCE(NEW.status, 'completed') <> 'completed' THEN
    RETURN NULL;
  END IF;
  SELECT organization_id, business_id, branch_id, transaction_number, transaction_type
    INTO v_txn FROM public.pos_transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    v_txn.organization_id, v_txn.branch_id, 'payment.received',
    'pos_transaction', NEW.transaction_id,
    jsonb_build_object(
      'payment_id', NEW.id, 'transaction_id', NEW.transaction_id,
      'transaction_number', v_txn.transaction_number,
      'transaction_type', v_txn.transaction_type,
      'business_id', v_txn.business_id, 'branch_id', v_txn.branch_id,
      'payment_method', NEW.payment_method, 'amount', NEW.amount,
      'tendered_amount', NEW.tendered_amount, 'change_given', NEW.change_given,
      'reference', NEW.reference, 'mpesa_receipt_number', NEW.mpesa_receipt_number,
      'processed_at', NEW.processed_at),
    'pending',
    'payment.received:' || NEW.id::text,
    NULL, 'pos'
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NULL;
END $function$;