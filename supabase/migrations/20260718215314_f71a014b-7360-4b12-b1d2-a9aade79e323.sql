
CREATE OR REPLACE FUNCTION public.finalize_table_order(
  p_transaction_id uuid, p_payments jsonb,
  p_tip_amount numeric DEFAULT 0,
  p_created_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_txn RECORD;
  v_payment JSONB;
  v_total_paid NUMERIC := 0;
  v_total_tendered NUMERIC := 0;
  v_total_change NUMERIC := 0;
  v_payment_status TEXT;
  v_track_inventory BOOLEAN;
  v_available_stock NUMERIC;
  v_insufficient_stock JSONB := '[]'::JSONB;
  v_item RECORD;
  v_register_code TEXT;
  v_final_txn_number TEXT;
  v_p_amount NUMERIC;
  v_p_tendered NUMERIC;
  v_p_change NUMERIC;
  v_p_method TEXT;
BEGIN
  SELECT * INTO v_txn FROM pos_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_found');
  END IF;
  IF v_txn.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_pending', 'details', 'Transaction status is: ' || v_txn.status);
  END IF;

  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory, stock_quantity INTO v_track_inventory, v_available_stock
      FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_track_inventory = true AND COALESCE(v_available_stock, 0) < v_item.quantity THEN
        v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', v_item.description,
          'requested', v_item.quantity,
          'available', COALESCE(v_available_stock, 0)
        );
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_insufficient_stock) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient_stock);
  END IF;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    v_p_method   := v_payment->>'payment_method';
    v_p_amount   := COALESCE((v_payment->>'amount')::NUMERIC, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::NUMERIC, v_p_amount);
    v_p_change   := COALESCE((v_payment->>'change_given')::NUMERIC, GREATEST(0, v_p_tendered - v_p_amount));

    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;

    v_total_paid     := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change   := v_total_change + v_p_change;
  END LOOP;

  v_payment_status := CASE WHEN v_total_paid >= v_txn.total THEN 'paid' ELSE 'partial' END;

  SELECT register_code INTO v_register_code FROM pos_registers WHERE id = v_txn.register_id;
  v_final_txn_number := get_next_pos_transaction_number(v_txn.organization_id, COALESCE(v_register_code, 'REG'));

  UPDATE pos_transactions SET
    status = 'completed',
    payment_status = v_payment_status,
    completed_at = now(),
    tip_amount = COALESCE(p_tip_amount, 0),
    transaction_number = v_final_txn_number,
    updated_at = now(),
    version = version + 1
  WHERE id = p_transaction_id;

  -- Wave 2 · Phase C-3: route every payment through _pos_record_payment so
  -- the FSM guard trigger validates card auth_state at insert time and the
  -- catalog validator rejects mis-configured tenders. Restaurant path now
  -- matches retail (process_pos_transaction) at the DB level.
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    PERFORM public._pos_record_payment(
      p_transaction_id,
      v_txn.organization_id,
      v_txn.business_id,
      v_txn.branch_id,
      v_payment
    );
  END LOOP;

  FOR v_item IN SELECT * FROM pos_transaction_items WHERE transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_item.product_id;
      IF v_track_inventory = true THEN
        UPDATE products
          SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - v_item.quantity),
              updated_at = now()
          WHERE id = v_item.product_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE pos_shifts SET
    total_sales = COALESCE(total_sales, 0) + v_txn.total,
    transaction_count = COALESCE(transaction_count, 0) + 1,
    total_tax = COALESCE(total_tax, 0) + v_txn.tax_amount,
    total_discount = COALESCE(total_discount, 0) + COALESCE(v_txn.discount_amount, 0),
    total_tips = COALESCE(total_tips, 0) + COALESCE(p_tip_amount, 0),
    updated_at = now()
  WHERE id = v_txn.shift_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'transaction_number', v_final_txn_number,
    'change', v_total_change,
    'tendered', v_total_tendered
  );
END;
$function$;

-- Card FSM outbox event emitter.
CREATE OR REPLACE FUNCTION public.tg_emit_pos_card_fsm_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
BEGIN
  IF COALESCE(NEW.tender_kind, '') <> 'card' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_event := CASE NEW.auth_state
      WHEN 'approved' THEN 'payment.card.authorized'
      WHEN 'captured' THEN 'payment.card.captured'
      ELSE NULL
    END;
  ELSIF TG_OP = 'UPDATE' AND OLD.auth_state IS DISTINCT FROM NEW.auth_state THEN
    v_event := CASE
      WHEN NEW.auth_state = 'approved' THEN 'payment.card.authorized'
      WHEN NEW.auth_state = 'captured' THEN 'payment.card.captured'
      WHEN NEW.auth_state = 'voided'   THEN 'payment.card.voided'
      WHEN NEW.auth_state = 'refunded' THEN 'payment.card.reversed'
      ELSE NULL
    END;
  END IF;

  IF v_event IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, v_event,
    'pos_transaction_payment', NEW.id,
    jsonb_build_object(
      'payment_id', NEW.id,
      'transaction_id', NEW.transaction_id,
      'amount', NEW.amount,
      'authorized_amount', NEW.authorized_amount,
      'auth_id', NEW.auth_id,
      'vendor_txn_id', NEW.vendor_txn_id,
      'card_last_four', NEW.card_last_four,
      'card_type', NEW.card_type,
      'from_state', CASE WHEN TG_OP='UPDATE' THEN OLD.auth_state ELSE NULL END,
      'to_state', NEW.auth_state
    ),
    'pos_card_fsm:' || NEW.id::text || ':' || NEW.auth_state,
    'trigger:pos_card_fsm'
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emit_pos_card_fsm_event ON public.pos_transaction_payments;
CREATE TRIGGER trg_emit_pos_card_fsm_event
  AFTER INSERT OR UPDATE OF auth_state ON public.pos_transaction_payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_emit_pos_card_fsm_event();

-- Register topics. All server-scope. producer_domain='pos', consumers empty
-- (Phase F wires settlement/reconciliation consumers).
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, handler_scope, max_attempts)
VALUES
  ('payment.card.authorized', 'pos', ARRAY['finance','reconciliation']::text[], 'server', 10),
  ('payment.card.captured',   'pos', ARRAY['finance','reconciliation']::text[], 'server', 10),
  ('payment.card.voided',     'pos', ARRAY['finance','reconciliation']::text[], 'server', 10),
  ('payment.card.reversed',   'pos', ARRAY['finance','reconciliation']::text[], 'server', 10)
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope = EXCLUDED.handler_scope,
      max_attempts = EXCLUDED.max_attempts,
      consumer_domains = EXCLUDED.consumer_domains;
