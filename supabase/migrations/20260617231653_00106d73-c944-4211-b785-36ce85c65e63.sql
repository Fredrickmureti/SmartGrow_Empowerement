-- =============================================================================
-- Wholesale lifecycle audit — Critical + High fixes (2026-06-17)
--
-- 1. Emit `invoice.confirmed` outbox event via AFTER UPDATE trigger.
-- 2. Emit `delivery_note.completed` outbox event via AFTER UPDATE trigger.
--    Also repair the existing dispatched trigger (it referenced non-existent
--    columns warehouse_id / invoice_id and threw at runtime).
-- 3. Wire `stock_transfer.dispatched` to the status the RPC actually sets
--    (`approved`), so the event is no longer dead.
-- 4. Close race on concurrent SO->Invoice vs DN->Invoice by locking DN rows
--    inside convert_so_to_invoice_atomic.
-- 5. Stop tagging receive-side in-transit OUT movement with from_branch_id —
--    the in-transit warehouse is a virtual cross-branch buffer; OUT-of-transit
--    rows should not credit any source-branch P&L. Tag with to_branch_id so
--    the receiving branch sees the full inbound flow and the source-branch
--    outflow already accounted on dispatch isn't double-counted.
-- 6. Add multi-currency FX guardrail on record_multi_invoice_payment:
--    require an explicit _exchange_rate when invoice currency differs from
--    business base_currency; pass it through to the journal entry.
-- =============================================================================


-- ───── (1) invoice.confirmed outbox event ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_invoice_emit_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.publish_business_event(
      NEW.organization_id, NEW.branch_id, NULL,
      'invoice.confirmed', 'invoice', NEW.id,
      jsonb_build_object(
        'invoice_id', NEW.id,
        'invoice_number', NEW.invoice_number,
        'contact_id', NEW.contact_id,
        'total', NEW.total,
        'currency', NEW.currency,
        'source_sales_order_id', NEW.source_sales_order_id
      ),
      'inv-confirmed:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_emit_confirmed ON public.invoices;
CREATE TRIGGER invoices_emit_confirmed
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_emit_confirmed();


-- ───── (2) repair broken DN-dispatched trigger + add DN-completed event ─────
CREATE OR REPLACE FUNCTION public.tg_delivery_note_emit_dispatched()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('dispatched','in_transit') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.publish_business_event(
      NEW.organization_id, NEW.branch_id, NULL,
      'delivery_note.dispatched', 'delivery_note', NEW.id,
      jsonb_build_object(
        'delivery_note_id', NEW.id,
        'delivery_number', NEW.delivery_number,
        'source_invoice_id', NEW.source_invoice_id,
        'sales_order_id', NEW.sales_order_id
      ),
      'dn-dispatched:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_delivery_note_emit_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('delivered','partial','returned') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.publish_business_event(
      NEW.organization_id, NEW.branch_id, NULL,
      'delivery_note.completed', 'delivery_note', NEW.id,
      jsonb_build_object(
        'delivery_note_id', NEW.id,
        'delivery_number', NEW.delivery_number,
        'status', NEW.status,
        'source_invoice_id', NEW.source_invoice_id,
        'spawned_invoice_id', NEW.spawned_invoice_id,
        'sales_order_id', NEW.sales_order_id,
        'contact_id', NEW.contact_id
      ),
      'dn-completed:' || NEW.id::text || ':' || NEW.status,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_notes_emit_completed ON public.delivery_notes;
CREATE TRIGGER delivery_notes_emit_completed
  AFTER UPDATE OF status ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_delivery_note_emit_completed();


-- ───── (3) stock_transfer.dispatched fires on actual status ('approved') ────
CREATE OR REPLACE FUNCTION public.tg_stock_transfer_emit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('approved','in_transit')
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND COALESCE(OLD.status,'') NOT IN ('approved','in_transit') THEN
    PERFORM public.publish_business_event(
      NEW.organization_id, NEW.from_branch_id, NEW.from_warehouse_id,
      'stock_transfer.dispatched', 'stock_transfer', NEW.id,
      jsonb_build_object('transfer_id', NEW.id,
        'transfer_number', NEW.transfer_number,
        'from_warehouse_id', NEW.from_warehouse_id,
        'to_warehouse_id', NEW.to_warehouse_id),
      'st-dispatched:' || NEW.id::text,
      auth.uid()
    );
  ELSIF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    PERFORM public.publish_business_event(
      NEW.organization_id, NEW.to_branch_id, NEW.to_warehouse_id,
      'stock_transfer.received', 'stock_transfer', NEW.id,
      jsonb_build_object('transfer_id', NEW.id,
        'transfer_number', NEW.transfer_number),
      'st-received:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;


-- ───── (4) close SO->Invoice vs DN->Invoice race with row locks ────────────
CREATE OR REPLACE FUNCTION public.convert_so_to_invoice_atomic(p_so_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_so RECORD;
  v_inv_number text;
  v_inv_id uuid;
  v_spawned_count int;
  v_all_fulfilled boolean;
  v_any_fulfilled boolean;
  v_new_status text;
BEGIN
  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales order % not found', p_so_id; END IF;

  IF v_so.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % already converted to invoice %', v_so.so_number, v_so.converted_invoice_id;
  END IF;

  -- Lock all DNs for this SO so a concurrent complete_delivery_atomic
  -- (which spawns an invoice from a DN) cannot race past this guard.
  PERFORM 1 FROM public.delivery_notes
   WHERE sales_order_id = p_so_id
   FOR UPDATE;

  SELECT count(*) INTO v_spawned_count
    FROM public.delivery_notes
   WHERE sales_order_id = p_so_id
     AND spawned_invoice_id IS NOT NULL;
  IF v_spawned_count > 0 THEN
    RAISE EXCEPTION 'Sales order % already has % invoice(s) raised from its delivery notes — cannot raise a duplicate invoice from the SO.',
      v_so.so_number, v_spawned_count
      USING ERRCODE = '22023';
  END IF;

  IF v_so.status NOT IN ('confirmed','processing','partial','fulfilled') THEN
    RAISE EXCEPTION 'Cannot convert sales order in status % — must be confirmed first', v_so.status;
  END IF;
  IF NOT public.user_can_access_business(p_user_id, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_so.business_id;
  END IF;

  SELECT public.get_next_invoice_number(v_so.organization_id, v_so.business_id) INTO v_inv_number;

  INSERT INTO public.invoices(
    organization_id, business_id, branch_id, contact_id,
    invoice_number, status, issue_date, due_date,
    subtotal, tax_amount, discount_amount, total, currency,
    notes, created_by, salesperson_id, payment_term_id,
    source_sales_order_id
  ) VALUES (
    v_so.organization_id, v_so.business_id, v_so.branch_id, v_so.contact_id,
    v_inv_number, 'draft', CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
    v_so.subtotal, v_so.tax_amount, v_so.discount_amount, v_so.total, v_so.currency,
    v_so.notes, p_user_id, COALESCE(v_so.salesperson_id, p_user_id), v_so.payment_term_id,
    p_so_id
  ) RETURNING id INTO v_inv_id;

  INSERT INTO public.invoice_items(
    invoice_id, product_id, description, quantity, unit_price,
    tax_rate, tax_amount, discount_percent, line_total, sort_order
  )
  SELECT
    v_inv_id, soi.product_id, soi.description, soi.quantity, soi.unit_price,
    COALESCE(soi.tax_rate,0), COALESCE(soi.tax_amount,0),
    COALESCE(soi.discount_percent,0), soi.line_total, soi.sort_order
  FROM public.sales_order_items soi
  WHERE soi.sales_order_id = p_so_id;

  SELECT bool_and(COALESCE(quantity_fulfilled,0) >= quantity),
         bool_or(COALESCE(quantity_fulfilled,0) > 0)
    INTO v_all_fulfilled, v_any_fulfilled
    FROM public.sales_order_items
   WHERE sales_order_id = p_so_id;

  v_new_status := CASE
    WHEN v_all_fulfilled THEN 'invoiced'
    WHEN v_any_fulfilled THEN 'partial'
    ELSE v_so.status
  END;

  UPDATE public.sales_orders
  SET status = v_new_status,
      converted_invoice_id = v_inv_id,
      converted_at = now(),
      updated_at = now()
  WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_inv_id,
    'invoice_number', v_inv_number,
    'so_status', v_new_status
  );
END;
$$;


-- ───── (5) fix receive-side in-transit OUT movement branch tag ─────────────
CREATE OR REPLACE FUNCTION public.complete_stock_transfer_atomic(p_transfer_id uuid, p_items jsonb, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_transfer RECORD; v_transfer_item RECORD; v_elem jsonb;
  v_in_transit_wh uuid; v_in_transit_qty numeric; v_received numeric;
  v_is_lot_tracked boolean;
  v_alloc jsonb; v_alloc_qty numeric; v_take numeric; v_remaining numeric;
BEGIN
  SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transfer not found');
  END IF;
  IF v_transfer.status != 'approved' THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Transfer must be in approved status. Current: ' || v_transfer.status);
  END IF;

  v_in_transit_wh := public.get_or_create_in_transit_warehouse(v_transfer.business_id);

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_transfer_item
      FROM public.stock_transfer_items
     WHERE id = (v_elem->>'id')::uuid
       AND transfer_id = p_transfer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transfer item % not found', v_elem->>'id';
    END IF;

    v_received := (v_elem->>'quantity_received')::numeric;
    IF v_received <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(quantity, 0) INTO v_in_transit_qty
      FROM public.warehouse_stock
     WHERE warehouse_id = v_in_transit_wh
       AND product_id   = v_transfer_item.product_id
     FOR UPDATE;
    IF v_in_transit_qty < v_received THEN
      RAISE EXCEPTION 'In-transit stock for product % is %, cannot receive %',
        v_transfer_item.product_id, v_in_transit_qty, v_received;
    END IF;

    UPDATE public.stock_transfer_items
       SET quantity_received = v_received
     WHERE id = v_transfer_item.id;

    SELECT COALESCE(is_lot_tracked, false) INTO v_is_lot_tracked
      FROM public.products WHERE id = v_transfer_item.product_id;

    IF v_is_lot_tracked
       AND v_transfer_item.dispatch_allocations IS NOT NULL
       AND jsonb_array_length(v_transfer_item.dispatch_allocations) > 0 THEN
      v_remaining := v_received;
      FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_transfer_item.dispatch_allocations) LOOP
        EXIT WHEN v_remaining <= 0;
        v_alloc_qty := (v_alloc->>'qty')::numeric;
        v_take := LEAST(v_alloc_qty, v_remaining);

        -- Out of in-transit (negative) — tagged to DESTINATION branch so the
        -- in-transit buffer drains against the receiving branch. The source
        -- branch outflow was already booked at dispatch.
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
          v_transfer_item.product_id, v_in_transit_wh,
          'transfer', -v_take, 'stock_transfer', p_transfer_id,
          'Receive out of transit (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id
        );
        -- Into destination (positive)
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, reference_type, reference_id,
          notes, lot_number, serial_number, created_by
        ) VALUES (
          v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
          v_transfer_item.product_id, v_transfer.to_warehouse_id,
          'transfer', v_take, 'stock_transfer', p_transfer_id,
          'Receive (' || v_transfer.transfer_number || ')',
          v_alloc->>'lot_number', v_alloc->>'serial_number', p_user_id
        );
        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Stored dispatch allocations (%) shorter than received qty % for product %',
          v_transfer_item.dispatch_allocations, v_received, v_transfer_item.product_id;
      END IF;
    ELSE
      -- Non-lot-tracked: same branch-tag fix on the OUT-of-transit leg.
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
        v_transfer_item.product_id, v_in_transit_wh,
        'transfer', -v_received, 'stock_transfer', p_transfer_id,
        'Receive out of transit (' || v_transfer.transfer_number || ')', p_user_id
      );
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, reference_type, reference_id, notes, created_by
      ) VALUES (
        v_transfer.organization_id, v_transfer.business_id, v_transfer.to_branch_id,
        v_transfer_item.product_id, v_transfer.to_warehouse_id,
        'transfer', v_received, 'stock_transfer', p_transfer_id,
        'Receive (' || v_transfer.transfer_number || ')', p_user_id
      );
    END IF;
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('success', true);
END;
$$;


-- ───── (6) FX guardrail on record_multi_invoice_payment ────────────────────
CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(
  _org_id uuid,
  _business_id uuid,
  _contact_id uuid,
  _allocations jsonb,
  _total_amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _customer_credit_account_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _exchange_rate numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_alloc record;
  v_invoice record;
  v_sum_allocated numeric := 0;
  v_excess numeric := 0;
  v_new_amount_paid numeric;
  v_new_status invoice_status;
  v_invoice_statuses jsonb := '[]'::jsonb;
  v_contact_name text;
  v_currency text;
  v_base_currency text;
  v_alloc_count int := 0;
  v_invoice_ids uuid[];
  v_distinct_business int;
  v_distinct_org int;
  v_distinct_contact int;
  v_distinct_currency int;
  v_distinct_nonnull_branch int;
  v_has_null_branch boolean;
  v_resolved_business uuid;
  v_resolved_org uuid;
  v_resolved_contact uuid;
  v_resolved_branch uuid;
  v_account_ok int;
  v_existing_payment record;
  v_lines jsonb;
BEGIN
  IF _total_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive.'; END IF;
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Select the GL account that will receive these funds.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is not configured. Map it under Settings > Default Accounts.';
  END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'No invoices were selected for this payment.';
  END IF;

  IF _receipt_number IS NOT NULL AND _org_id IS NOT NULL THEN
    SELECT p.id, p.journal_entry_id, p.amount, p.outstanding_amount, p.applied_amount
      INTO v_existing_payment
      FROM payments p
     WHERE p.organization_id = _org_id AND p.receipt_number = _receipt_number
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing_payment.id,
        'journal_entry_id', v_existing_payment.journal_entry_id,
        'allocated', v_existing_payment.applied_amount,
        'excess', v_existing_payment.outstanding_amount,
        'excess_amount', v_existing_payment.outstanding_amount,
        'credit_note_id', NULL,
        'invoice_statuses', '[]'::jsonb,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT array_agg((x->>'invoice_id')::uuid)
    INTO v_invoice_ids
    FROM jsonb_array_elements(_allocations) AS x
   WHERE COALESCE((x->>'amount')::numeric, 0) > 0;

  IF v_invoice_ids IS NULL OR array_length(v_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  PERFORM 1 FROM invoices WHERE id = ANY(v_invoice_ids) FOR UPDATE;

  IF (SELECT count(*) FROM invoices WHERE id = ANY(v_invoice_ids)) <> array_length(v_invoice_ids, 1) THEN
    RAISE EXCEPTION 'One or more selected invoices could not be found. They may have been deleted.';
  END IF;

  SELECT count(DISTINCT business_id), count(DISTINCT organization_id),
         count(DISTINCT contact_id), count(DISTINCT COALESCE(currency, 'USD')),
         count(DISTINCT branch_id), bool_or(branch_id IS NULL)
    INTO v_distinct_business, v_distinct_org, v_distinct_contact, v_distinct_currency,
         v_distinct_nonnull_branch, v_has_null_branch
    FROM invoices WHERE id = ANY(v_invoice_ids);

  IF v_distinct_business > 1 OR v_distinct_org > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different companies and cannot be paid together.';
  END IF;
  IF v_distinct_contact > 1 THEN
    RAISE EXCEPTION 'Selected invoices belong to different customers and cannot be paid together.';
  END IF;
  IF v_distinct_currency > 1 THEN
    RAISE EXCEPTION 'Selected invoices use different currencies and cannot be paid together.';
  END IF;
  IF v_distinct_nonnull_branch > 1 OR (v_distinct_nonnull_branch = 1 AND v_has_null_branch) THEN
    RAISE EXCEPTION 'Selected invoices span different branch scopes. Record separate payments per branch/HQ scope.';
  END IF;

  SELECT business_id, organization_id, contact_id, COALESCE(currency, 'USD')
    INTO v_resolved_business, v_resolved_org, v_resolved_contact, v_currency
    FROM invoices WHERE id = ANY(v_invoice_ids) LIMIT 1;

  IF v_distinct_nonnull_branch = 1 THEN
    SELECT DISTINCT branch_id INTO v_resolved_branch
      FROM invoices WHERE id = ANY(v_invoice_ids) AND branch_id IS NOT NULL;
  ELSE
    v_resolved_branch := NULL;
  END IF;

  IF _org_id IS NOT NULL AND _org_id <> v_resolved_org THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active workspace.';
  END IF;
  IF _business_id IS NOT NULL AND _business_id <> v_resolved_business THEN
    RAISE EXCEPTION 'Selected invoices do not belong to the active company.';
  END IF;
  IF _contact_id IS NOT NULL AND _contact_id <> v_resolved_contact THEN
    RAISE EXCEPTION 'Payment customer does not match selected invoices.';
  END IF;
  IF _branch_id IS NOT NULL AND v_resolved_branch IS NOT NULL AND _branch_id <> v_resolved_branch THEN
    RAISE EXCEPTION 'Selected invoices belong to a different branch than the active branch.';
  END IF;

  _org_id := v_resolved_org;
  _business_id := v_resolved_business;
  _contact_id := v_resolved_contact;
  _branch_id := COALESCE(_branch_id, v_resolved_branch);

  -- FX guardrail: GL is denominated in business base_currency. If the invoice
  -- currency differs, an explicit exchange rate is required so the JE can be
  -- translated correctly. Previously silent — caused AR drift.
  SELECT COALESCE(base_currency, 'USD') INTO v_base_currency
    FROM businesses WHERE id = _business_id;
  IF v_currency <> v_base_currency AND _exchange_rate IS NULL THEN
    RAISE EXCEPTION 'Foreign-currency invoice (% vs base %). An explicit exchange_rate is required to record this payment.',
      v_currency, v_base_currency
      USING ERRCODE = '22023';
  END IF;
  IF _exchange_rate IS NOT NULL AND _exchange_rate <= 0 THEN
    RAISE EXCEPTION 'Exchange rate must be positive.';
  END IF;

  SELECT name INTO v_contact_name
    FROM contacts
   WHERE id = _contact_id AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found in the active workspace/company.'; END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM branches
     WHERE id = _branch_id AND organization_id = _org_id AND business_id = _business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected branch does not belong to the active company.'; END IF;
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _deposit_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Deposit account must be a posting asset account in the active company.';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM accounts WHERE id = _receivable_account_id
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Accounts Receivable account must be a posting asset account in the active company.';
  END IF;

  INSERT INTO payments (
    organization_id, business_id, branch_id, contact_id, amount,
    outstanding_amount, applied_amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, _business_id, _branch_id, _contact_id, _total_amount,
    _total_amount, 0,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  FOR v_alloc IN
    SELECT (x->>'invoice_id')::uuid AS invoice_id, (x->>'amount')::numeric AS amount
      FROM jsonb_array_elements(_allocations) AS x
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN CONTINUE; END IF;

    SELECT id, invoice_number, total, COALESCE(amount_paid, 0) AS amount_paid,
           status, branch_id, journal_entry_id
      INTO v_invoice FROM invoices WHERE id = v_alloc.invoice_id;

    IF v_invoice.status::text IN ('paid','void','voided','cancelled') THEN
      RAISE EXCEPTION 'Invoice % is already % and cannot receive a payment.', v_invoice.invoice_number, v_invoice.status;
    END IF;
    IF v_invoice.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Invoice % has no posted journal entry. Payments can only settle posted invoices.', v_invoice.invoice_number;
    END IF;
    IF v_alloc.amount > (v_invoice.total - v_invoice.amount_paid) + 0.000001 THEN
      RAISE EXCEPTION 'Allocation of % to invoice % exceeds its outstanding balance of %.',
        v_alloc.amount, v_invoice.invoice_number, (v_invoice.total - v_invoice.amount_paid);
    END IF;

    INSERT INTO payment_allocations (payment_id, invoice_id, amount, branch_id)
    VALUES (v_payment_id, v_alloc.invoice_id, v_alloc.amount, COALESCE(v_invoice.branch_id, _branch_id));

    v_new_amount_paid := v_invoice.amount_paid + v_alloc.amount;
    IF v_new_amount_paid >= v_invoice.total - 0.000001 THEN
      v_new_status := 'paid'::invoice_status;
    ELSE
      v_new_status := 'partial'::invoice_status;
    END IF;

    UPDATE invoices
       SET amount_paid = v_new_amount_paid, status = v_new_status, updated_at = now()
     WHERE id = v_alloc.invoice_id;

    v_sum_allocated := v_sum_allocated + v_alloc.amount;
    v_alloc_count := v_alloc_count + 1;

    v_invoice_statuses := v_invoice_statuses || jsonb_build_object(
      'invoice_id', v_alloc.invoice_id,
      'new_status', v_new_status,
      'new_amount_paid', v_new_amount_paid
    );
  END LOOP;

  IF v_alloc_count = 0 THEN
    RAISE EXCEPTION 'No invoices with a positive allocation amount were provided.';
  END IF;

  v_excess := _total_amount - v_sum_allocated;
  IF v_excess < -0.000001 THEN
    RAISE EXCEPTION 'Allocation total (%) exceeds payment amount (%).', v_sum_allocated, _total_amount;
  END IF;
  IF v_excess < 0 THEN v_excess := 0; END IF;

  IF v_excess > 0 THEN
    IF _customer_credit_account_id IS NULL THEN
      RAISE EXCEPTION 'Overpayment of % cannot be processed: Customer Deposits account is not configured.', v_excess;
    END IF;
    SELECT count(*) INTO v_account_ok
      FROM accounts WHERE id = _customer_credit_account_id
       AND organization_id = _org_id AND business_id = _business_id
       AND account_type = 'liability'::account_type AND COALESCE(is_header, false) = false;
    IF v_account_ok = 0 THEN
      RAISE EXCEPTION 'Customer Deposits account must be a posting liability account in the active company.';
    END IF;
  END IF;

  UPDATE payments
     SET applied_amount = v_sum_allocated, outstanding_amount = v_excess
   WHERE id = v_payment_id;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', _deposit_account_id, 'debit', _total_amount, 'credit', 0,
      'description', 'Payment received from ' || v_contact_name, 'contact_id', _contact_id),
    jsonb_build_object('account_id', _receivable_account_id, 'debit', 0, 'credit', v_sum_allocated,
      'description', 'Allocated to ' || v_alloc_count || ' invoice(s)', 'contact_id', _contact_id)
  );
  IF v_excess > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', _customer_credit_account_id, 'debit', 0, 'credit', v_excess,
        'description', 'Customer deposit / overpayment', 'contact_id', _contact_id)
    );
  END IF;

  v_je_number := generate_next_je_number(_org_id, _business_id);
  v_je_id := post_journal_entry_atomic(
    _org_id, _business_id,
    v_je_number, _payment_date,
    'PMT-' || COALESCE(_receipt_number, v_payment_id::text),
    'Payment from ' || v_contact_name,
    'payment', v_payment_id, _created_by,
    false, false,
    v_lines, v_currency,
    _exchange_rate,             -- NEW: pass through FX rate to JE
    NULL, _branch_id
  );

  UPDATE payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'currency', v_currency,
    'exchange_rate', _exchange_rate,
    'allocated', v_sum_allocated,
    'applied_amount', v_sum_allocated,
    'excess', v_excess,
    'excess_amount', v_excess,
    'outstanding_amount', v_excess,
    'credit_note_id', NULL,
    'invoice_statuses', v_invoice_statuses
  );
END;
$$;