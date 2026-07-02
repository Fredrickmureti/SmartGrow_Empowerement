-- =====================================================================
-- POS Stage R8 / R9 / R2 — read-side RLS hardening, orphan backfill,
-- and in-RPC defense-in-depth assertions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- R9 — Backfill safety net (idempotent; expected to be 0 rows here).
-- ---------------------------------------------------------------------
UPDATE public.pos_held_transactions h
   SET branch_id = r.branch_id
  FROM public.pos_registers r
 WHERE h.register_id = r.id
   AND h.branch_id IS NULL;

UPDATE public.pos_table_sessions s
   SET branch_id = t.branch_id
  FROM public.pos_tables t
 WHERE s.table_id = t.id
   AND s.branch_id IS NULL;

-- ---------------------------------------------------------------------
-- R8 — Read-side RLS: every SELECT policy on a branch-bearing POS
-- table must restrict to branches the caller can access. NULL branch_id
-- (company-shared) remains visible to org members.
-- ---------------------------------------------------------------------

-- pos_floors: existing v2 omitted the branch clause.
DROP POLICY IF EXISTS pos_floors_select_v2 ON public.pos_floors;
CREATE POLICY pos_floors_select_v2
  ON public.pos_floors
  FOR SELECT
  TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_kitchen_orders: was org-member only.
DROP POLICY IF EXISTS "Users can view kitchen orders in their organization" ON public.pos_kitchen_orders;
CREATE POLICY pos_kitchen_orders_select_branch_scoped
  ON public.pos_kitchen_orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_manager_overrides: was org-only.
DROP POLICY IF EXISTS "Users can view overrides in their organization" ON public.pos_manager_overrides;
CREATE POLICY pos_manager_overrides_select_branch_scoped
  ON public.pos_manager_overrides
  FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT user_roles.organization_id FROM public.user_roles WHERE user_roles.user_id = auth.uid()
    )
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_table_bookings
DROP POLICY IF EXISTS "Users can view bookings in their organization" ON public.pos_table_bookings;
CREATE POLICY pos_table_bookings_select_branch_scoped
  ON public.pos_table_bookings
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_table_sessions
DROP POLICY IF EXISTS "Users can view table sessions in their organization" ON public.pos_table_sessions;
CREATE POLICY pos_table_sessions_select_branch_scoped
  ON public.pos_table_sessions
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_waitlist
DROP POLICY IF EXISTS "Users can view waitlist in their organization" ON public.pos_waitlist;
CREATE POLICY pos_waitlist_select_branch_scoped
  ON public.pos_waitlist
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_cashier_registers
DROP POLICY IF EXISTS "Users can view cashier register assignments" ON public.pos_cashier_registers;
CREATE POLICY pos_cashier_registers_select_branch_scoped
  ON public.pos_cashier_registers
  FOR SELECT
  TO authenticated
  USING (
    cashier_id IN (
      SELECT pos_cashiers.id FROM public.pos_cashiers
       WHERE pos_cashiers.organization_id IN (
         SELECT user_roles.organization_id FROM public.user_roles WHERE user_roles.user_id = auth.uid()
       )
    )
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_drawer_events
DROP POLICY IF EXISTS "Drawer events readable by business members" ON public.pos_drawer_events;
CREATE POLICY pos_drawer_events_select_branch_scoped
  ON public.pos_drawer_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.business_id = pos_drawer_events.business_id
         AND uba.user_id = auth.uid()
    )
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- pos_sessions: drop the v2 SELECT policy that omitted the branch check.
-- The branch-aware "Users can view POS sessions from their branch" policy
-- remains and is the single SELECT path. v2 is redundant and dangerous
-- because RLS OR-combines policies for the same role.
DROP POLICY IF EXISTS pos_sessions_select_v2 ON public.pos_sessions;
CREATE POLICY pos_sessions_select_v2
  ON public.pos_sessions
  FOR SELECT
  TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'pos', 'read')
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

-- ---------------------------------------------------------------------
-- R2 — Defense-in-depth: every money-handling RPC asserts the caller's
-- branch authority *before* doing any work. Triggers already cover row
-- writes, but the RPCs do read/compute/insert across multiple tables
-- (assert_manager_override stamping, shift mutations, stock_movements)
-- and must fail-fast on cross-branch invocations.
-- ---------------------------------------------------------------------

-- process_pos_transaction
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid, p_business_id uuid, p_register_id uuid, p_shift_id uuid,
  p_items jsonb, p_payments jsonb, p_subtotal numeric, p_tax_amount numeric,
  p_discount_amount numeric, p_total numeric, p_transaction_type text DEFAULT 'sale',
  p_customer_id uuid DEFAULT NULL, p_customer_tin text DEFAULT NULL,
  p_customer_name text DEFAULT NULL, p_notes text DEFAULT NULL,
  p_cashier_id uuid DEFAULT NULL, p_created_by uuid DEFAULT NULL,
  p_original_transaction_id uuid DEFAULT NULL, p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_transaction_id uuid; v_transaction_number text; v_register_code text;
  v_register_branch_id uuid; v_register_business_id uuid; v_register_org_id uuid;
  v_shift_warehouse_id uuid; v_default_warehouse_id uuid;
  v_item jsonb; v_payment jsonb; v_product_id uuid; v_quantity numeric;
  v_track_inventory boolean; v_on_hand numeric; v_reserved numeric;
  v_total_paid numeric := 0; v_total_tendered numeric := 0; v_total_change numeric := 0;
  v_cash_total numeric := 0; v_payment_status text := 'paid';
  v_item_index integer := 0; v_existing record; v_insufficient jsonb := '[]'::jsonb;
  v_product_name text; v_currency text; v_snapshot jsonb;
  v_p_amount numeric; v_p_tendered numeric; v_p_change numeric; v_p_method text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, transaction_number, branch_id, business_id, total INTO v_existing
    FROM public.pos_transactions
    WHERE organization_id = p_organization_id AND business_id = p_business_id
      AND register_id = p_register_id AND idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotent_replay', true,
        'transaction_id', v_existing.id, 'transaction_number', v_existing.transaction_number,
        'change', 0, 'branch_id', v_existing.branch_id, 'business_id', v_existing.business_id);
    END IF;
  END IF;

  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register not found');
  END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context');
  END IF;

  -- R2 defense-in-depth: refuse cross-branch calls before any side effects.
  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  IF p_transaction_type = 'sale' AND COALESCE(p_total, 0) > 0
     AND (p_payments IS NULL OR jsonb_array_length(p_payments) = 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_payments',
      'detail', 'A sale with a positive total requires at least one payment line.');
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id FROM public.pos_shifts
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND register_id = p_register_id;
  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id AND business_id = v_register_business_id
       AND branch_id = v_register_branch_id AND is_active = true
       AND COALESCE(is_in_transit, false) = false
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  IF p_transaction_type <> 'return' AND v_default_warehouse_id IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
      IF v_product_id IS NULL OR v_quantity <= 0 THEN CONTINUE; END IF;
      SELECT track_inventory, COALESCE(NULLIF(name,''), '') INTO v_track_inventory, v_product_name
      FROM public.products WHERE id = v_product_id
        AND organization_id = v_register_org_id AND business_id = v_register_business_id;
      IF v_track_inventory IS NOT TRUE THEN CONTINUE; END IF;
      SELECT COALESCE(SUM(sm.quantity), 0),
        COALESCE((SELECT SUM(quantity) FROM public.pos_stock_reservations
                   WHERE register_id = p_register_id AND product_id = v_product_id), 0)
      INTO v_on_hand, v_reserved FROM public.stock_movements sm
      WHERE sm.product_id = v_product_id AND sm.warehouse_id = v_default_warehouse_id;
      IF v_on_hand - v_reserved < v_quantity THEN
        v_insufficient := v_insufficient || jsonb_build_object(
          'product_id', v_product_id, 'product_name', v_product_name,
          'requested', v_quantity, 'available', GREATEST(0, v_on_hand - v_reserved));
      END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(v_insufficient) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient);
  END IF;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    IF v_p_tendered < v_p_amount - 0.005 THEN
      RAISE EXCEPTION 'Payment line % has tendered (%) less than applied (%)', v_p_method, v_p_tendered, v_p_amount
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_p_method <> 'cash' AND v_p_change > 0.005 THEN
      RAISE EXCEPTION 'Non-cash payment % cannot return change (%)', v_p_method, v_p_change
        USING ERRCODE = 'check_violation';
    END IF;
    v_total_paid := v_total_paid + v_p_amount;
    v_total_tendered := v_total_tendered + v_p_tendered;
    v_total_change := v_total_change + v_p_change;
    IF v_p_method = 'cash' THEN v_cash_total := v_cash_total + v_p_amount; END IF;
  END LOOP;
  v_payment_status := CASE WHEN v_total_paid + 0.005 >= COALESCE(p_total, 0) THEN 'paid' ELSE 'partial' END;
  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, COALESCE(v_register_code, 'REG'));
  v_snapshot := jsonb_build_object('items', p_items, 'payments', p_payments, 'committed_at', now());

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name, notes, cashier_id, created_by,
    table_session_id, status, completed_at, created_at, idempotency_key, snapshot
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name, p_notes,
    p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now(), p_idempotency_key, v_snapshot
  ) RETURNING id INTO v_transaction_id;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order, tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric, COALESCE((v_item->>'cost_price')::numeric, 0),
      v_item_index, NULLIF(v_item->>'tax_rate_id', '')::uuid, v_item->>'etims_tax_code');
    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM public.products
      WHERE id = v_product_id AND organization_id = v_register_org_id
        AND business_id = v_register_business_id;
      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch % — create a branch warehouse before selling tracked inventory', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          COALESCE((v_item->>'cost_price')::numeric, 0),
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id), now());
      END IF;
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    v_p_method := v_payment->>'payment_method';
    v_p_amount := COALESCE((v_payment->>'amount')::numeric, 0);
    v_p_tendered := COALESCE((v_payment->>'tendered_amount')::numeric, v_p_amount);
    v_p_change := COALESCE((v_payment->>'change_given')::numeric, GREATEST(0, v_p_tendered - v_p_amount));
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, tendered_amount, change_given, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id, v_p_method, v_p_amount, v_p_tendered, v_p_change,
      v_payment->>'reference', v_payment->>'card_last_four', v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number', 'completed', now());
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN p_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND branch_id = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET status = 'completed', closed_at = now(),
      total_amount = p_total, updated_at = now() WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'idempotent_replay', false,
    'transaction_id', v_transaction_id, 'transaction_number', v_transaction_number,
    'change', v_total_change, 'tendered', v_total_tendered,
    'branch_id', v_register_branch_id, 'business_id', v_register_business_id);
END;
$function$;

-- process_pos_void — add PERFORM near top after v_tx is loaded.
CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_organization_id uuid, p_transaction_id uuid, p_void_reason_id uuid,
  p_void_note text DEFAULT NULL, p_voided_by uuid DEFAULT NULL, p_override_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_tx RECORD; v_reason RECORD; v_shift_status text; v_warehouse_id uuid;
  v_item RECORD; v_cash_refund numeric := 0; v_has_return boolean;
BEGIN
  SELECT * INTO v_tx FROM public.pos_transactions
   WHERE id = p_transaction_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_tx IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_found','details','Transaction not found');
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_tx.branch_id);

  IF v_tx.status = 'voided' THEN
    RETURN jsonb_build_object('success',false,'error','already_voided','details','Already voided');
  END IF;
  IF v_tx.status <> 'completed' THEN
    RETURN jsonb_build_object('success',false,'error','invalid_status',
      'details','Only completed transactions can be voided (status: '||v_tx.status||')');
  END IF;
  SELECT status INTO v_shift_status FROM public.pos_shifts WHERE id = v_tx.shift_id;
  IF v_shift_status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success',false,'error','shift_not_open',
      'details','Voids are only allowed within the same open shift. Use a return instead.');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.pos_transactions
     WHERE original_transaction_id = p_transaction_id
       AND transaction_type = 'return' AND status <> 'voided') INTO v_has_return;
  IF v_has_return THEN
    RETURN jsonb_build_object('success',false,'error','return_exists',
      'details','A return has already been processed against this transaction; void is no longer allowed.');
  END IF;
  SELECT * INTO v_reason FROM public.pos_void_reasons WHERE id = p_void_reason_id AND is_active = true;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','invalid_reason',
      'details','Void reason is required and must be active');
  END IF;
  IF v_reason.requires_note AND COALESCE(btrim(p_void_note),'') = '' THEN
    RETURN jsonb_build_object('success',false,'error','note_required',
      'details','Selected void reason requires a note');
  END IF;

  PERFORM public.assert_manager_override('void_above_threshold', v_tx.total,
    p_organization_id, v_tx.business_id, v_tx.shift_id, p_override_id,
    'pos_transactions', p_transaction_id);

  SELECT s.warehouse_id INTO v_warehouse_id FROM public.pos_shifts s WHERE s.id = v_tx.shift_id;
  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id FROM public.warehouses
     WHERE organization_id = v_tx.organization_id AND business_id = v_tx.business_id
       AND branch_id = v_tx.branch_id AND is_active = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;
  FOR v_item IN SELECT ti.product_id, ti.quantity, ti.cost_price, p.track_inventory
      FROM public.pos_transaction_items ti
      LEFT JOIN public.products p ON p.id = ti.product_id
     WHERE ti.transaction_id = p_transaction_id LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for branch % — cannot reverse stock for void', v_tx.branch_id
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
      ) VALUES (
        v_tx.organization_id, v_tx.business_id, v_tx.branch_id,
        v_item.product_id, v_warehouse_id, 'pos_return', v_item.quantity, COALESCE(v_item.cost_price,0),
        'pos_transaction', p_transaction_id,
        'Voided: '||v_tx.transaction_number||' — '||v_reason.code, p_voided_by, now());
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(amount),0) INTO v_cash_refund FROM public.pos_transaction_payments
   WHERE transaction_id = p_transaction_id AND payment_method = 'cash'
     AND COALESCE(status,'completed') <> 'voided';
  IF v_cash_refund > 0 THEN
    UPDATE public.pos_shifts SET expected_cash = COALESCE(expected_cash,0) - v_cash_refund, updated_at = now()
     WHERE id = v_tx.shift_id;
  END IF;

  UPDATE public.pos_transactions SET status='voided', reversal_type='void_post_payment',
    voided_by=p_voided_by, voided_at=now(), void_reason=v_reason.code, void_reason_id=v_reason.id,
    void_note=NULLIF(btrim(COALESCE(p_void_note,'')),''), void_override_id=p_override_id, updated_at=now()
   WHERE id = p_transaction_id;
  UPDATE public.pos_transaction_payments SET status='voided' WHERE transaction_id = p_transaction_id;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides SET transaction_id = p_transaction_id,
      metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
        'void_reason_code', v_reason.code, 'voided_amount', v_tx.total)
     WHERE id = p_override_id;
  END IF;

  RETURN jsonb_build_object('success',true,'transaction_id',p_transaction_id,
    'transaction_number',v_tx.transaction_number,
    'voided_amount',v_tx.total,'reversal_type','void_post_payment');
END;
$function$;

-- process_pos_return — add PERFORM after register branch resolution.
CREATE OR REPLACE FUNCTION public.process_pos_return(
  p_organization_id uuid, p_register_id uuid, p_shift_id uuid,
  p_original_transaction_id uuid, p_items jsonb, p_refund_method text DEFAULT 'cash',
  p_notes text DEFAULT NULL, p_created_by uuid DEFAULT NULL, p_override_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_transaction_id UUID; v_transaction_number TEXT; v_register_code TEXT;
  v_register_branch_id UUID; v_register_business_id UUID; v_register_org_id UUID;
  v_shift_warehouse_id UUID; v_default_warehouse_id UUID; v_item JSONB;
  v_product_id UUID; v_quantity NUMERIC; v_track_inventory BOOLEAN;
  v_subtotal NUMERIC := 0; v_tax_amount NUMERIC := 0; v_total NUMERIC := 0;
  v_item_index INT := 0; v_original_status TEXT; v_original_business_id UUID;
  v_original_item_id UUID; v_returnable NUMERIC; v_item_total NUMERIC; v_item_tax NUMERIC;
  v_reason_id UUID; v_reason_code TEXT; v_reason_requires_note BOOLEAN;
  v_reason_requires_override BOOLEAN; v_reason_note TEXT;
  v_unit_price NUMERIC; v_tax_rate NUMERIC; v_cost_price NUMERIC; v_description TEXT;
  v_refund_tender TEXT; v_is_cross_tender BOOLEAN := false;
  v_any_reason_needs_override BOOLEAN := false; v_override_reason_codes TEXT := '';
BEGIN
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers WHERE id = p_register_id;
  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;
  IF v_register_org_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization than supplied', p_register_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register has no branch context');
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  SELECT status, business_id INTO v_original_status, v_original_business_id
  FROM public.pos_transactions
  WHERE id = p_original_transaction_id AND organization_id = p_organization_id;
  IF v_original_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_not_found', 'details', 'Original transaction not found');
  END IF;
  IF v_original_status = 'voided' THEN
    RETURN jsonb_build_object('success', false, 'error', 'original_voided', 'details', 'Cannot return a voided transaction');
  END IF;
  IF v_original_status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'details', 'Original transaction is not completed (status: ' || v_original_status || ')');
  END IF;
  IF v_original_business_id IS DISTINCT FROM v_register_business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cross_company_return',
      'details', 'Original transaction belongs to a different company than this register');
  END IF;

  v_refund_tender := CASE WHEN p_refund_method = 'store_credit' THEN 'voucher' ELSE p_refund_method END;
  SELECT NOT EXISTS (SELECT 1 FROM public.pos_transaction_payments
     WHERE transaction_id = p_original_transaction_id AND payment_method = v_refund_tender
       AND COALESCE(status, 'completed') = 'completed') INTO v_is_cross_tender;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    IF v_original_item_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_original_item',
        'details', 'Each return line must reference an original_item_id');
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_quantity',
        'details', 'Return quantity must be greater than zero');
    END IF;
    SELECT returnable_qty INTO v_returnable FROM public.v_pos_returnable_qty
    WHERE original_item_id = v_original_item_id AND original_transaction_id = p_original_transaction_id;
    IF v_returnable IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'item_not_found',
        'details', 'Original item not found on this transaction');
    END IF;
    IF v_quantity > v_returnable THEN
      RETURN jsonb_build_object('success', false, 'error', 'over_return',
        'details', format('Cannot return %s — only %s remaining for this line', v_quantity, v_returnable));
    END IF;
    v_reason_id := NULLIF(v_item->>'return_reason_id','')::UUID;
    IF v_reason_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'missing_reason',
        'details', 'A return reason is required for every line');
    END IF;
    SELECT code, requires_note, requires_manager_override
      INTO v_reason_code, v_reason_requires_note, v_reason_requires_override
    FROM public.pos_return_reasons WHERE id = v_reason_id AND is_active = true;
    IF v_reason_code IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_reason',
        'details', 'Selected return reason is not valid');
    END IF;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    IF v_reason_requires_note AND v_reason_note IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_required',
        'details', format('Reason "%s" requires an explanatory note', v_reason_code));
    END IF;
    IF NOT v_reason_requires_note AND v_reason_note IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'reason_note_not_allowed',
        'details', 'Free-text note only allowed for reasons that require a note');
    END IF;
    IF COALESCE(v_reason_requires_override, false) THEN
      v_any_reason_needs_override := true;
      IF position(v_reason_code IN v_override_reason_codes) = 0 THEN
        v_override_reason_codes := v_override_reason_codes ||
          CASE WHEN v_override_reason_codes = '' THEN '' ELSE ',' END || v_reason_code;
      END IF;
    END IF;
    SELECT unit_price, tax_rate INTO v_unit_price, v_tax_rate
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    v_subtotal := v_subtotal + v_item_total;
    v_tax_amount := v_tax_amount + v_item_tax;
  END LOOP;
  v_total := v_subtotal + v_tax_amount;

  IF v_any_reason_needs_override AND p_override_id IS NULL THEN
    RAISE EXCEPTION 'override_required'
      USING ERRCODE = 'check_violation',
            HINT = format('Reason(s) %s require manager approval', v_override_reason_codes),
            DETAIL = 'reason_requires_override';
  END IF;

  IF v_is_cross_tender THEN
    PERFORM public.assert_manager_override('cross_tender_refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  ELSE
    PERFORM public.assert_manager_override('refund', v_total, p_organization_id,
      v_register_business_id, p_shift_id, p_override_id, 'pos_transactions', NULL);
  END IF;

  SELECT warehouse_id INTO v_shift_warehouse_id FROM public.pos_shifts
  WHERE id = p_shift_id AND organization_id = v_register_org_id
    AND business_id = v_register_business_id AND register_id = p_register_id;
  v_default_warehouse_id := v_shift_warehouse_id;
  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id FROM public.warehouses
     WHERE organization_id = v_register_org_id AND business_id = v_register_business_id
       AND branch_id = v_register_branch_id AND is_active = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;
  v_transaction_number := public.get_next_pos_transaction_number(p_organization_id, v_register_code);

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id, subtotal, tax_amount, discount_amount, total,
    payment_status, status, completed_at, created_by, notes, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number, 'return', p_original_transaction_id,
    v_subtotal, v_tax_amount, 0, v_total, 'refunded', 'completed', now(), p_created_by,
    COALESCE(p_notes, '') || ' Return for txn ' || p_original_transaction_id::TEXT, now()
  ) RETURNING id INTO v_transaction_id;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides SET consumed_ref_id = v_transaction_id,
      transaction_id = v_transaction_id, amount = v_total,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'original_transaction_id', p_original_transaction_id,
        'refund_tender', v_refund_tender, 'is_cross_tender', v_is_cross_tender,
        'reason_required_override', v_any_reason_needs_override,
        'override_reason_codes', v_override_reason_codes)
     WHERE id = p_override_id;
  END IF;

  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_original_item_id := (v_item->>'original_item_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;
    v_reason_id := (v_item->>'return_reason_id')::UUID;
    v_reason_note := NULLIF(trim(coalesce(v_item->>'return_reason_note','')), '');
    SELECT product_id, unit_price, tax_rate, cost_price, description
      INTO v_product_id, v_unit_price, v_tax_rate, v_cost_price, v_description
    FROM public.v_pos_returnable_qty WHERE original_item_id = v_original_item_id;
    v_item_total := v_unit_price * v_quantity;
    v_item_tax := v_item_total * COALESCE(v_tax_rate, 0) / 100;
    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity, unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      original_item_id, return_reason_id, return_reason_note
    ) VALUES (
      v_transaction_id, v_product_id, v_description, v_quantity, v_unit_price, NULL, 0,
      COALESCE(v_tax_rate, 0), v_item_tax, v_item_total + v_item_tax,
      v_cost_price, v_item_index, v_original_item_id, v_reason_id, v_reason_note);
    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM public.products
      WHERE id = v_product_id AND organization_id = p_organization_id AND business_id = v_register_business_id;
      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse for POS register branch %; create one before processing returns', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          p_organization_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id, 'pos_return', v_quantity, COALESCE(v_cost_price, 0),
          'pos_transaction', v_transaction_id, 'POS Return: ' || v_transaction_number, p_created_by, now());
      END IF;
    END IF;
    v_item_index := v_item_index + 1;
  END LOOP;

  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, status,
    organization_id, business_id, branch_id
  ) VALUES (
    v_transaction_id, v_refund_tender, -v_total, 'Refund - ' || v_transaction_number, 'completed',
    p_organization_id, v_register_business_id, v_register_branch_id);

  IF p_refund_method = 'cash' THEN
    UPDATE public.pos_shifts SET expected_cash = COALESCE(expected_cash, 0) - v_total,
      total_returns = COALESCE(total_returns, 0) + v_total, updated_at = now() WHERE id = p_shift_id;
  ELSE
    UPDATE public.pos_shifts SET total_returns = COALESCE(total_returns, 0) + v_total,
      updated_at = now() WHERE id = p_shift_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number, 'refund_amount', v_total,
    'business_id', v_register_business_id, 'branch_id', v_register_branch_id,
    'cross_tender', v_is_cross_tender, 'reason_required_override', v_any_reason_needs_override);
END;
$function$;

-- pos_add_cash_movement — resolve register branch, then PERFORM.
CREATE OR REPLACE FUNCTION public.pos_add_cash_movement(
  p_organization_id uuid, p_shift_id uuid, p_register_id uuid,
  p_movement_type text, p_amount numeric, p_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL, p_performed_by uuid DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_movement_id uuid; v_new_expected numeric; v_register_branch_id uuid;
BEGIN
  SELECT branch_id INTO v_register_branch_id FROM public.pos_registers WHERE id = p_register_id;
  PERFORM public.assert_pos_caller_branch_access(v_register_branch_id);

  INSERT INTO pos_cash_movements (
    organization_id, shift_id, register_id, movement_type, amount, reason, notes, performed_by
  ) VALUES (
    p_organization_id, p_shift_id, p_register_id, p_movement_type, p_amount, p_reason, p_notes, p_performed_by
  ) RETURNING id INTO v_movement_id;

  IF p_movement_type IN ('cash_in', 'float') THEN
    UPDATE pos_shifts SET expected_cash = COALESCE(expected_cash, 0) + p_amount
    WHERE id = p_shift_id RETURNING expected_cash INTO v_new_expected;
  ELSIF p_movement_type IN ('cash_out', 'pickup') THEN
    UPDATE pos_shifts SET expected_cash = COALESCE(expected_cash, 0) - p_amount
    WHERE id = p_shift_id RETURNING expected_cash INTO v_new_expected;
  END IF;

  RETURN json_build_object('success', true, 'movement_id', v_movement_id, 'new_expected_cash', v_new_expected);
END;
$function$;

-- process_pos_drawer_event — already resolves branch; add PERFORM.
CREATE OR REPLACE FUNCTION public.process_pos_drawer_event(
  p_register_id uuid, p_shift_id uuid, p_reason text,
  p_transaction_id uuid DEFAULT NULL, p_reason_note text DEFAULT NULL,
  p_hardware_success boolean DEFAULT NULL, p_hardware_result jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_org_id uuid; v_business_id uuid; v_branch_id uuid;
  v_event_id uuid; v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  SELECT organization_id, business_id, branch_id
    INTO v_org_id, v_business_id, v_branch_id
  FROM public.pos_registers WHERE id = p_register_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'register not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_business_access
    WHERE business_id = v_business_id AND user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_branch_id);

  INSERT INTO public.pos_drawer_events (
    organization_id, business_id, branch_id, register_id, shift_id,
    transaction_id, reason, reason_note, triggered_by, triggered_at,
    hardware_success, hardware_result
  ) VALUES (
    v_org_id, v_business_id, v_branch_id, p_register_id, p_shift_id,
    p_transaction_id, p_reason, p_reason_note, v_user, now(),
    p_hardware_success, COALESCE(p_hardware_result, '{}'::jsonb))
  RETURNING id INTO v_event_id;
  RETURN v_event_id;
END;
$function$;

-- recall_pos_held_transaction — assert on v_held.branch_id.
CREATE OR REPLACE FUNCTION public.recall_pos_held_transaction(p_held_id uuid, p_shift_id uuid)
RETURNS pos_held_transactions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_held public.pos_held_transactions;
  v_shift_status text; v_shift_register uuid;
BEGIN
  IF p_held_id IS NULL OR p_shift_id IS NULL THEN
    RAISE EXCEPTION 'held_id and shift_id are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_held FROM public.pos_held_transactions WHERE id = p_held_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'held_order_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_held.business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_held.branch_id);

  IF v_held.status <> 'held' THEN
    RAISE EXCEPTION 'held_order_already_%', v_held.status
      USING ERRCODE = 'invalid_parameter_value', DETAIL = 'held_order_not_recallable';
  END IF;
  IF v_held.shift_id IS DISTINCT FROM p_shift_id THEN
    RAISE EXCEPTION 'shift_mismatch'
      USING ERRCODE = 'invalid_parameter_value', DETAIL = 'held_order_belongs_to_other_shift';
  END IF;
  SELECT status, register_id INTO v_shift_status, v_shift_register
  FROM public.pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift_status <> 'open' THEN
    RAISE EXCEPTION 'shift_not_open_for_recall'
      USING ERRCODE = 'invalid_parameter_value', DETAIL = format('shift_status=%s', v_shift_status);
  END IF;
  UPDATE public.pos_held_transactions SET status = 'resumed', updated_at = now()
   WHERE id = p_held_id RETURNING * INTO v_held;
  RETURN v_held;
END;
$function$;

-- close_pos_shift — assert on v_shift.branch_id.
CREATE OR REPLACE FUNCTION public.close_pos_shift(
  p_shift_id uuid, p_actual_cash numeric, p_notes text DEFAULT NULL,
  p_blind_close boolean DEFAULT false, p_manager_override_id uuid DEFAULT NULL,
  p_denomination_counted boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_shift public.pos_shifts; v_gate jsonb;
  v_expected numeric := 0; v_variance numeric := 0;
  v_require_denom boolean := false; v_allow_blind boolean := true;
  v_actual numeric;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_shift.branch_id);

  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift is not open (status=%)', v_shift.status USING ERRCODE = 'check_violation';
  END IF;
  v_gate := public.can_close_pos_shift(p_shift_id);
  IF NOT (v_gate->>'ok')::boolean THEN
    UPDATE public.pos_shifts SET close_blocked_reasons = (v_gate->'reasons') WHERE id = p_shift_id;
    RAISE EXCEPTION 'Cannot close shift: %', v_gate->>'reasons'
      USING ERRCODE = 'check_violation', DETAIL = (v_gate->>'reasons');
  END IF;
  SELECT COALESCE(require_denomination_count, false), COALESCE(allow_blind_close, true)
  INTO v_require_denom, v_allow_blind FROM public.pos_security_settings
  WHERE organization_id = v_shift.organization_id
    AND (business_id IS NULL OR business_id = v_shift.business_id)
  ORDER BY business_id NULLS LAST LIMIT 1;
  IF p_blind_close AND NOT v_allow_blind THEN
    RAISE EXCEPTION 'Blind close is disabled for this business' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT p_blind_close AND v_require_denom AND NOT p_denomination_counted THEN
    RAISE EXCEPTION 'Denomination count is required to close this shift' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(expected_cash_computed, v_shift.expected_cash, 0) INTO v_expected
  FROM public.v_pos_cash_expected WHERE shift_id = p_shift_id;
  IF v_expected IS NULL THEN v_expected := COALESCE(v_shift.expected_cash, 0); END IF;
  v_actual := CASE WHEN p_blind_close THEN v_expected ELSE p_actual_cash END;
  v_variance := v_actual - v_expected;
  IF NOT p_blind_close THEN
    PERFORM public.assert_manager_override('shift_variance', abs(v_variance),
      v_shift.organization_id, v_shift.business_id, p_shift_id,
      p_manager_override_id, 'pos_shifts', p_shift_id);
  END IF;
  PERFORM set_config('pos.allow_close', 'true', true);
  UPDATE public.pos_shifts SET status = 'closed', closed_at = now(), closed_by = auth.uid(),
    actual_cash = v_actual, expected_cash = v_expected, cash_difference = v_variance,
    variance_override_id = p_manager_override_id, close_blocked_reasons = '[]'::jsonb,
    notes = COALESCE(p_notes, notes), updated_at = now()
   WHERE id = p_shift_id;
  RETURN jsonb_build_object('success', true, 'shift_id', p_shift_id,
    'expected_cash', v_expected, 'actual_cash', v_actual, 'variance', v_variance,
    'journal_entry_id', (SELECT journal_entry_id FROM public.pos_shifts WHERE id = p_shift_id));
END;
$function$;

-- verify_cashier_pin — assert that caller can access the cashier's branch.
-- Prevents a Branch A operator from validating a Branch B cashier PIN.
CREATE OR REPLACE FUNCTION public.verify_cashier_pin(p_cashier_id uuid, p_pin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE
  v_pin_hash TEXT; v_is_active BOOLEAN; v_branch_id uuid;
BEGIN
  SELECT pin_hash, is_active, branch_id INTO v_pin_hash, v_is_active, v_branch_id
  FROM public.pos_cashiers WHERE id = p_cashier_id;
  IF NOT FOUND OR NOT v_is_active THEN
    RETURN FALSE;
  END IF;

  -- R2 defense-in-depth.
  PERFORM public.assert_pos_caller_branch_access(v_branch_id);

  RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$function$;

COMMENT ON FUNCTION public.assert_pos_caller_branch_access(uuid) IS
  'POS Stage R2: caller-authority guard. Called at the top of every money-handling RPC '
  '(process_pos_transaction, process_pos_void, process_pos_return, pos_add_cash_movement, '
  'process_pos_drawer_event, recall_pos_held_transaction, close_pos_shift, verify_cashier_pin) '
  'as defense-in-depth alongside the per-table BEFORE triggers.';