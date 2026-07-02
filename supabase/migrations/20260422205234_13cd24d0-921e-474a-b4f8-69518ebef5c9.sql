
-- =========================================================================
-- POS HARDENING — Stage 1 (Database)
-- TB-1: FK ON DELETE RESTRICT for branch on pos_registers/cashiers/shifts/sessions
-- TB-3: get_pos_dashboard_stats — drop business_id IS NULL leak
-- TB-4: drop legacy permissive RLS policies on pos_* (keep v2 + branch policies)
-- TB-6: process_pos_transaction — re-derive business_id from register, validate
-- TB-7: pos_sessions/pos_shifts.branch_id SET NOT NULL
-- AI-1: pos_sessions branch-scoped read policy
-- AI-4: pos_shifts.warehouse_id snapshot at shift open + RPC uses it
-- =========================================================================

-- ---------------------------------------------------------------------------
-- TB-1: Flip branch FKs to RESTRICT (audit-safe; branches must be soft-archived)
-- ---------------------------------------------------------------------------
ALTER TABLE public.pos_registers DROP CONSTRAINT IF EXISTS pos_registers_branch_id_fkey;
ALTER TABLE public.pos_registers
  ADD CONSTRAINT pos_registers_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.pos_cashiers DROP CONSTRAINT IF EXISTS pos_cashiers_branch_id_fkey;
ALTER TABLE public.pos_cashiers
  ADD CONSTRAINT pos_cashiers_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.pos_shifts DROP CONSTRAINT IF EXISTS pos_shifts_branch_id_fkey;
ALTER TABLE public.pos_shifts
  ADD CONSTRAINT pos_shifts_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;

ALTER TABLE public.pos_sessions DROP CONSTRAINT IF EXISTS pos_sessions_branch_id_fkey;
ALTER TABLE public.pos_sessions
  ADD CONSTRAINT pos_sessions_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- TB-7: branch_id NOT NULL on pos_sessions and pos_shifts
-- (verified: zero NULL rows). Defensive backfill from register before SET NOT NULL.
-- ---------------------------------------------------------------------------
UPDATE public.pos_sessions s
   SET branch_id = r.branch_id
  FROM public.pos_registers r
 WHERE s.register_id = r.id
   AND s.branch_id IS NULL;

UPDATE public.pos_shifts sh
   SET branch_id = r.branch_id
  FROM public.pos_registers r
 WHERE sh.register_id = r.id
   AND sh.branch_id IS NULL;

ALTER TABLE public.pos_sessions ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.pos_shifts   ALTER COLUMN branch_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- AI-4: warehouse snapshot on pos_shifts (locked at shift open)
-- ---------------------------------------------------------------------------
ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS warehouse_id uuid
    REFERENCES public.warehouses(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.stamp_pos_shift_warehouse_from_register()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch uuid;
  v_wh uuid;
BEGIN
  IF NEW.warehouse_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_branch
  FROM public.pos_registers
  WHERE id = NEW.register_id;

  -- Prefer branch default warehouse, then any active for branch, then business default
  SELECT id INTO v_wh
  FROM public.warehouses
  WHERE organization_id = NEW.organization_id
    AND business_id     = NEW.business_id
    AND branch_id       = COALESCE(v_branch, NEW.branch_id)
    AND is_active       = true
  ORDER BY is_default DESC, created_at ASC
  LIMIT 1;

  IF v_wh IS NULL THEN
    SELECT id INTO v_wh
    FROM public.warehouses
    WHERE organization_id = NEW.organization_id
      AND business_id     = NEW.business_id
      AND is_default      = true
      AND is_active       = true
    LIMIT 1;
  END IF;

  NEW.warehouse_id := v_wh;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_pos_shift_warehouse ON public.pos_shifts;
CREATE TRIGGER trg_stamp_pos_shift_warehouse
  BEFORE INSERT ON public.pos_shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_pos_shift_warehouse_from_register();

-- Backfill warehouse for existing open shifts (best-effort)
UPDATE public.pos_shifts sh
   SET warehouse_id = w.id
  FROM public.warehouses w
 WHERE sh.warehouse_id IS NULL
   AND w.organization_id = sh.organization_id
   AND w.business_id     = sh.business_id
   AND w.branch_id       = sh.branch_id
   AND w.is_active       = true
   AND w.is_default      = true;

-- ---------------------------------------------------------------------------
-- TB-4: Drop legacy permissive RLS (org-only) on pos_* tables
-- Keep v2 (business+module) policies and branch-read policies.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage transactions in their organization" ON public.pos_transactions;
DROP POLICY IF EXISTS "Users can view transactions in their organization"   ON public.pos_transactions;
DROP POLICY IF EXISTS "Users can manage shifts in their organization"       ON public.pos_shifts;
DROP POLICY IF EXISTS "Users can view shifts in their organization"         ON public.pos_shifts;
DROP POLICY IF EXISTS "Users can manage registers in their organization"    ON public.pos_registers;
DROP POLICY IF EXISTS "Users can view registers in their organization"      ON public.pos_registers;

-- ---------------------------------------------------------------------------
-- AI-1: branch-scoped read policy on pos_sessions
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view POS sessions from their branch" ON public.pos_sessions;
CREATE POLICY "Users can view POS sessions from their branch"
ON public.pos_sessions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
      AND user_roles.organization_id = pos_sessions.organization_id
      AND user_roles.is_active = true
  )
  AND ((branch_id IS NULL) OR public.can_access_branch(auth.uid(), branch_id))
);

-- ---------------------------------------------------------------------------
-- TB-3: Patch get_pos_dashboard_stats — remove `OR business_id IS NULL` leaks
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pos_dashboard_stats(
  _org_id uuid,
  _business_id uuid,
  _date date DEFAULT CURRENT_DATE,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  result jsonb;
  day_start timestamptz;
  day_end timestamptz;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required';
  END IF;

  day_start := _date::timestamptz;
  day_end := (_date + interval '1 day')::timestamptz;

  SELECT jsonb_build_object(
    'today_sales', COALESCE(SUM(CASE WHEN t.transaction_type = 'sale' THEN t.total ELSE 0 END), 0),
    'today_transactions', COALESCE(COUNT(*) FILTER (WHERE t.transaction_type = 'sale'), 0),
    'today_returns', COALESCE(SUM(CASE WHEN t.transaction_type = 'return' THEN t.total ELSE 0 END), 0),
    'today_returns_count', COALESCE(COUNT(*) FILTER (WHERE t.transaction_type = 'return'), 0),
    'average_basket', CASE
      WHEN COUNT(*) FILTER (WHERE t.transaction_type = 'sale') > 0
      THEN COALESCE(SUM(CASE WHEN t.transaction_type = 'sale' THEN t.total ELSE 0 END), 0)
           / COUNT(*) FILTER (WHERE t.transaction_type = 'sale')
      ELSE 0
    END,
    'payment_breakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('method', pm.payment_method, 'amount', pm.total_amount) ORDER BY pm.total_amount DESC)
      FROM (
        SELECT p.payment_method, SUM(p.amount) as total_amount
        FROM pos_transaction_payments p
        JOIN pos_transactions t2 ON t2.id = p.transaction_id
        WHERE t2.organization_id = _org_id
          AND t2.business_id    = _business_id
          AND t2.status         = 'completed'
          AND t2.transaction_type = 'sale'
          AND t2.created_at >= day_start
          AND t2.created_at <  day_end
          AND (_branch_id IS NULL OR t2.branch_id = _branch_id)
        GROUP BY p.payment_method
      ) pm
    ), '[]'::jsonb)
  ) INTO result
  FROM pos_transactions t
  WHERE t.organization_id = _org_id
    AND t.business_id    = _business_id
    AND t.status         = 'completed'
    AND t.created_at >= day_start
    AND t.created_at <  day_end
    AND (_branch_id IS NULL OR t.branch_id = _branch_id);

  RETURN COALESCE(result, jsonb_build_object(
    'today_sales', 0, 'today_transactions', 0, 'today_returns', 0,
    'today_returns_count', 0, 'average_basket', 0, 'payment_breakdown', '[]'::jsonb
  ));
END;
$function$;

-- ---------------------------------------------------------------------------
-- TB-6 + AI-4: Rewrite process_pos_transaction
--   * Re-derive business_id from register, raise on mismatch
--   * Use pos_shifts.warehouse_id snapshot first, fall back to branch default
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid,
  p_business_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_discount_amount numeric,
  p_total numeric,
  p_transaction_type text DEFAULT 'sale',
  p_customer_id uuid DEFAULT NULL,
  p_customer_tin text DEFAULT NULL,
  p_customer_name text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_cashier_id uuid DEFAULT NULL,
  p_created_by uuid DEFAULT NULL,
  p_original_transaction_id uuid DEFAULT NULL,
  p_tip_amount numeric DEFAULT 0,
  p_table_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_transaction_id uuid;
  v_transaction_number text;
  v_register_code text;
  v_register_branch_id uuid;
  v_register_business_id uuid;
  v_register_org_id uuid;
  v_shift_warehouse_id uuid;
  v_default_warehouse_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_track_inventory boolean;
  v_total_paid numeric := 0;
  v_cash_total numeric := 0;
  v_payment_status text := 'paid';
  v_item_index integer := 0;
BEGIN
  -- Single source of truth: register owns the (org, business, branch) tuple.
  SELECT register_code, branch_id, business_id, organization_id
    INTO v_register_code, v_register_branch_id, v_register_business_id, v_register_org_id
  FROM public.pos_registers
  WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register not found');
  END IF;

  -- Cross-company contamination guard.
  IF v_register_org_id IS DISTINCT FROM p_organization_id
     OR v_register_business_id IS DISTINCT FROM p_business_id THEN
    RAISE EXCEPTION 'Register % belongs to a different organization/business than supplied (org=%, biz=% vs supplied org=%, biz=%)',
      p_register_id, v_register_org_id, v_register_business_id, p_organization_id, p_business_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_register_branch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Register has no branch context');
  END IF;

  -- Warehouse: prefer shift-locked, then branch default, then business default.
  SELECT warehouse_id INTO v_shift_warehouse_id
  FROM public.pos_shifts
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND register_id     = p_register_id;

  v_default_warehouse_id := v_shift_warehouse_id;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_register_org_id
      AND business_id     = v_register_business_id
      AND branch_id       = v_register_branch_id
      AND is_active       = true
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM public.warehouses
    WHERE organization_id = v_register_org_id
      AND business_id     = v_register_business_id
      AND is_default      = true
      AND is_active       = true
    LIMIT 1;
  END IF;

  SELECT COALESCE(SUM((p->>'amount')::numeric), 0)
    INTO v_total_paid
  FROM jsonb_array_elements(p_payments) p;

  IF v_total_paid < p_total AND p_transaction_type = 'sale' THEN
    v_payment_status := 'partial';
  END IF;

  v_transaction_number := public.get_next_pos_transaction_number(v_register_org_id, COALESCE(v_register_code, 'REG'));

  INSERT INTO public.pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), v_register_org_id, v_register_business_id, v_register_branch_id,
    p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity   := (v_item->>'quantity')::numeric;

    INSERT INTO public.pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::numeric, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::numeric, 0),
      COALESCE((v_item->>'tax_rate')::numeric, 0),
      COALESCE((v_item->>'tax_amount')::numeric, 0),
      (v_item->>'line_total')::numeric,
      COALESCE((v_item->>'cost_price')::numeric, 0),
      v_item_index,
      NULLIF(v_item->>'tax_rate_id', '')::uuid,
      v_item->>'etims_tax_code'
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory
      FROM public.products
      WHERE id = v_product_id
        AND organization_id = v_register_org_id
        AND business_id     = v_register_business_id;

      IF v_track_inventory = true THEN
        IF v_default_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'No active warehouse found for POS register branch %', v_register_branch_id
            USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.stock_movements (
          organization_id, business_id, branch_id, product_id, warehouse_id,
          movement_type, quantity, unit_cost,
          reference_type, reference_id, notes, created_by, movement_date
        ) VALUES (
          v_register_org_id, v_register_business_id, v_register_branch_id,
          v_product_id, v_default_warehouse_id,
          CASE WHEN p_transaction_type = 'return' THEN 'pos_return' ELSE 'pos_sale' END,
          CASE WHEN p_transaction_type = 'return' THEN v_quantity ELSE -v_quantity END,
          COALESCE((v_item->>'cost_price')::numeric, 0),
          'pos_transaction', v_transaction_id,
          CASE WHEN p_transaction_type = 'return' THEN 'POS Return: ' ELSE 'POS Sale: ' END || v_transaction_number,
          COALESCE(p_created_by, p_cashier_id),
          now()
        );
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO public.pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::numeric,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );

    IF v_payment->>'payment_method' = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::numeric;
    END IF;
  END LOOP;

  UPDATE public.pos_shifts SET
    total_sales        = total_sales + CASE WHEN p_transaction_type = 'sale'   THEN p_total ELSE 0 END,
    total_returns      = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments      = cash_payments + v_cash_total,
    card_payments      = card_payments + (v_total_paid - v_cash_total),
    expected_cash      = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at         = now()
  WHERE id = p_shift_id
    AND organization_id = v_register_org_id
    AND business_id     = v_register_business_id
    AND branch_id       = v_register_branch_id;

  DELETE FROM public.pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE public.pos_table_sessions SET
      status       = 'completed',
      closed_at    = now(),
      total_amount = p_total,
      updated_at   = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total),
    'branch_id', v_register_branch_id,
    'business_id', v_register_business_id
  );
END;
$function$;
