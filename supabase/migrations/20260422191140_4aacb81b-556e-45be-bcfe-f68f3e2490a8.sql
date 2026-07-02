-- ============================================================
-- POS Branch-Dimension Closure (Fixes 1, 2, 3, 5, 7)
-- ============================================================
-- This migration closes the branch-dimension gaps in POS:
--   1. process_pos_transaction now resolves & stamps branch_id from the register
--   2. BEFORE INSERT trigger on pos_transactions auto-stamps branch_id from register (defense in depth)
--   3. Warehouse resolution prefers register's branch warehouse → business default → org default
--   4. post_pos_shift_gl propagates _branch_id to post_journal_entry_atomic
--   5. POS report RPCs gain optional p_branch_id filter
--   6. Default POS payment methods are seeded by trigger on businesses INSERT
-- ============================================================

-- ---- Fix 1 + 3: Rewrite process_pos_transaction to be branch-aware ----
CREATE OR REPLACE FUNCTION public.process_pos_transaction(
  p_organization_id uuid,
  p_register_id uuid,
  p_shift_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_discount_amount numeric,
  p_total numeric,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_customer_tin text DEFAULT NULL::text,
  p_customer_name text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_cashier_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid,
  p_transaction_type text DEFAULT 'sale'::text,
  p_table_session_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_tip_amount numeric DEFAULT 0,
  p_original_transaction_id uuid DEFAULT NULL::uuid,
  p_business_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_transaction_number TEXT;
  v_register_code TEXT;
  v_register_branch_id UUID;
  v_item JSONB;
  v_payment JSONB;
  v_product_id UUID;
  v_quantity NUMERIC;
  v_available_stock NUMERIC;
  v_track_inventory BOOLEAN;
  v_insufficient_stock JSONB := '[]'::JSONB;
  v_total_paid NUMERIC := 0;
  v_cash_total NUMERIC := 0;
  v_payment_status TEXT;
  v_item_index INT := 0;
  v_default_warehouse_id UUID;
BEGIN
  -- Get register code AND branch_id (single source of truth: never trust client)
  SELECT register_code, branch_id INTO v_register_code, v_register_branch_id
  FROM pos_registers WHERE id = p_register_id;

  IF v_register_code IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_register', 'details', 'Register not found');
  END IF;

  -- Branch-aware warehouse resolution:
  --   1) Caller-provided
  --   2) Default warehouse for the register's branch
  --   3) Any warehouse for the register's branch
  --   4) Business-default warehouse
  --   5) Org-default warehouse
  v_default_warehouse_id := p_warehouse_id;

  IF v_default_warehouse_id IS NULL AND v_register_branch_id IS NOT NULL AND p_business_id IS NOT NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM warehouses
    WHERE business_id = p_business_id
      AND branch_id = v_register_branch_id
      AND is_default = true
      AND COALESCE(is_active, true) = true
    LIMIT 1;

    IF v_default_warehouse_id IS NULL THEN
      SELECT id INTO v_default_warehouse_id
      FROM warehouses
      WHERE business_id = p_business_id
        AND branch_id = v_register_branch_id
        AND COALESCE(is_active, true) = true
      LIMIT 1;
    END IF;
  END IF;

  IF v_default_warehouse_id IS NULL AND p_business_id IS NOT NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM warehouses
    WHERE business_id = p_business_id AND is_default = true
      AND COALESCE(is_active, true) = true
    LIMIT 1;
  END IF;

  IF v_default_warehouse_id IS NULL THEN
    SELECT id INTO v_default_warehouse_id
    FROM warehouses
    WHERE organization_id = p_organization_id AND is_default = true
      AND COALESCE(is_active, true) = true
    LIMIT 1;
  END IF;

  -- Generate transaction number
  v_transaction_number := get_next_pos_transaction_number(p_organization_id, v_register_code);

  -- Stock check (sales only)
  IF p_transaction_type = 'sale' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_product_id := (v_item->>'product_id')::UUID;
      v_quantity := (v_item->>'quantity')::NUMERIC;
      IF v_product_id IS NOT NULL THEN
        SELECT track_inventory, stock_quantity INTO v_track_inventory, v_available_stock
        FROM products WHERE id = v_product_id FOR UPDATE;
        IF v_track_inventory = true AND COALESCE(v_available_stock, 0) < v_quantity THEN
          v_insufficient_stock := v_insufficient_stock || jsonb_build_object(
            'product_id', v_product_id,
            'product_name', v_item->>'name',
            'requested', v_quantity,
            'available', COALESCE(v_available_stock, 0)
          );
        END IF;
      END IF;
    END LOOP;

    IF jsonb_array_length(v_insufficient_stock) > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock', 'details', v_insufficient_stock);
    END IF;
  END IF;

  SELECT COALESCE(SUM((p->>'amount')::NUMERIC), 0) INTO v_total_paid
  FROM jsonb_array_elements(p_payments) AS p;

  v_payment_status := CASE WHEN v_total_paid >= p_total THEN 'paid' ELSE 'partial' END;

  -- Insert transaction WITH branch_id stamped from the register
  INSERT INTO pos_transactions (
    id, organization_id, business_id, branch_id, register_id, shift_id, transaction_number,
    transaction_type, original_transaction_id,
    subtotal, tax_amount, discount_amount, total, tip_amount,
    payment_status, customer_id, customer_tin, customer_name,
    notes, cashier_id, created_by, table_session_id,
    status, completed_at, created_at
  ) VALUES (
    gen_random_uuid(), p_organization_id, p_business_id, v_register_branch_id, p_register_id, p_shift_id, v_transaction_number,
    p_transaction_type, p_original_transaction_id,
    p_subtotal, p_tax_amount, p_discount_amount, p_total, COALESCE(p_tip_amount, 0),
    v_payment_status, p_customer_id, p_customer_tin, p_customer_name,
    p_notes, p_cashier_id, COALESCE(p_created_by, p_cashier_id), p_table_session_id,
    'completed', now(), now()
  ) RETURNING id INTO v_transaction_id;

  -- Items + stock movements
  v_item_index := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::UUID;
    v_quantity := (v_item->>'quantity')::NUMERIC;

    INSERT INTO pos_transaction_items (
      transaction_id, product_id, description, quantity,
      unit_price, discount_type, discount_value,
      tax_rate, tax_amount, line_total, cost_price, sort_order,
      tax_rate_id, etims_tax_code
    ) VALUES (
      v_transaction_id, v_product_id, v_item->>'name', v_quantity,
      (v_item->>'unit_price')::NUMERIC, v_item->>'discount_type',
      COALESCE((v_item->>'discount_value')::NUMERIC, 0),
      COALESCE((v_item->>'tax_rate')::NUMERIC, 0),
      COALESCE((v_item->>'tax_amount')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      (v_item->>'cost_price')::NUMERIC,
      v_item_index,
      (v_item->>'tax_rate_id')::UUID,
      v_item->>'etims_tax_code'
    );

    IF v_product_id IS NOT NULL THEN
      SELECT track_inventory INTO v_track_inventory FROM products WHERE id = v_product_id;
      IF v_track_inventory = true THEN
        IF p_transaction_type = 'sale' THEN
          INSERT INTO stock_movements (
            organization_id, business_id, product_id, warehouse_id,
            movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by, movement_date
          ) VALUES (
            p_organization_id, p_business_id, v_product_id, v_default_warehouse_id,
            'pos_sale', -v_quantity, COALESCE((v_item->>'cost_price')::NUMERIC, 0),
            'pos_transaction', v_transaction_id,
            'POS Sale: ' || v_transaction_number,
            COALESCE(p_created_by, p_cashier_id),
            now()
          );
        ELSIF p_transaction_type = 'return' THEN
          INSERT INTO stock_movements (
            organization_id, business_id, product_id, warehouse_id,
            movement_type, quantity, unit_cost,
            reference_type, reference_id, notes, created_by, movement_date
          ) VALUES (
            p_organization_id, p_business_id, v_product_id, v_default_warehouse_id,
            'pos_return', v_quantity, COALESCE((v_item->>'cost_price')::NUMERIC, 0),
            'pos_transaction', v_transaction_id,
            'POS Return: ' || v_transaction_number,
            COALESCE(p_created_by, p_cashier_id),
            now()
          );
        END IF;
      END IF;
    END IF;

    v_item_index := v_item_index + 1;
  END LOOP;

  -- Payments
  FOR v_payment IN SELECT * FROM jsonb_array_elements(p_payments)
  LOOP
    INSERT INTO pos_transaction_payments (
      transaction_id, payment_method, amount, reference,
      card_last_four, card_type, mpesa_receipt_number, status, processed_at
    ) VALUES (
      v_transaction_id,
      v_payment->>'payment_method',
      (v_payment->>'amount')::NUMERIC,
      v_payment->>'reference',
      v_payment->>'card_last_four',
      v_payment->>'card_type',
      v_payment->>'mpesa_receipt_number',
      'completed',
      now()
    );

    IF v_payment->>'payment_method' = 'cash' THEN
      v_cash_total := v_cash_total + (v_payment->>'amount')::NUMERIC;
    END IF;
  END LOOP;

  UPDATE pos_shifts SET
    total_sales = total_sales + CASE WHEN p_transaction_type = 'sale' THEN p_total ELSE 0 END,
    total_returns = total_returns + CASE WHEN p_transaction_type = 'return' THEN p_total ELSE 0 END,
    total_transactions = total_transactions + 1,
    cash_payments = cash_payments + v_cash_total,
    card_payments = card_payments + (v_total_paid - v_cash_total),
    expected_cash = COALESCE(expected_cash, 0) + v_cash_total,
    updated_at = now()
  WHERE id = p_shift_id;

  DELETE FROM pos_stock_reservations WHERE register_id = p_register_id;

  IF p_table_session_id IS NOT NULL THEN
    UPDATE pos_table_sessions SET
      status = 'completed',
      closed_at = now(),
      total_amount = p_total,
      updated_at = now()
    WHERE id = p_table_session_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'transaction_number', v_transaction_number,
    'change', GREATEST(0, v_total_paid - p_total)
  );
END;
$function$;

-- ---- Fix 1 (defense in depth): BEFORE INSERT trigger to auto-stamp branch_id ----
CREATE OR REPLACE FUNCTION public.stamp_pos_transaction_branch_from_register()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.register_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id
    FROM public.pos_registers WHERE id = NEW.register_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_transactions_stamp_branch ON public.pos_transactions;
CREATE TRIGGER trg_pos_transactions_stamp_branch
BEFORE INSERT ON public.pos_transactions
FOR EACH ROW
EXECUTE FUNCTION public.stamp_pos_transaction_branch_from_register();

-- Same for pos_shifts (so cashier-context drift can't corrupt branch attribution)
CREATE OR REPLACE FUNCTION public.stamp_pos_shift_branch_from_register()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.register_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id
    FROM public.pos_registers WHERE id = NEW.register_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_shifts_stamp_branch ON public.pos_shifts;
CREATE TRIGGER trg_pos_shifts_stamp_branch
BEFORE INSERT ON public.pos_shifts
FOR EACH ROW
EXECUTE FUNCTION public.stamp_pos_shift_branch_from_register();

-- ---- Fix 2: post_pos_shift_gl propagates branch_id ----
CREATE OR REPLACE FUNCTION public.post_pos_shift_gl(_shift_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_shift            RECORD;
  v_existing         uuid;
  v_org_id           uuid;
  v_business_id      uuid;
  v_branch_id        uuid;
  v_cash_account     uuid;
  v_revenue_account  uuid;
  v_tax_account      uuid;
  v_total_sales      numeric := 0;
  v_total_tax        numeric := 0;
  v_total_net        numeric := 0;
  v_shift_date       date;
  v_reference        text;
  v_entry_number     text;
  v_lines            jsonb;
  v_jeid             uuid;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS shift not found: %', _shift_id;
  END IF;

  v_existing := v_shift.journal_entry_id;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_org_id      := v_shift.organization_id;
  v_business_id := v_shift.business_id;
  v_branch_id   := v_shift.branch_id;
  -- Defense: re-derive from register if shift's branch_id is null
  IF v_branch_id IS NULL AND v_shift.register_id IS NOT NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_registers WHERE id = v_shift.register_id;
  END IF;
  v_shift_date  := COALESCE(v_shift.closed_at, v_shift.created_at, now())::date;
  v_reference   := 'POS-SHIFT-' || COALESCE(v_shift.shift_number, _shift_id::text);

  SELECT
    COALESCE(SUM(total), 0),
    COALESCE(SUM(tax_amount), 0),
    COALESCE(SUM(subtotal), 0)
  INTO v_total_sales, v_total_tax, v_total_net
  FROM public.pos_transactions
  WHERE shift_id = _shift_id
    AND transaction_type = 'sale'
    AND status = 'completed';

  IF v_total_sales = 0 THEN
    RETURN NULL;
  END IF;

  v_cash_account    := public.get_default_account_id(v_org_id, v_business_id, 'pos_cash');
  IF v_cash_account IS NULL THEN
    v_cash_account  := public.get_default_account_id(v_org_id, v_business_id, 'cash');
  END IF;
  v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'pos_revenue');
  IF v_revenue_account IS NULL THEN
    v_revenue_account := public.get_default_account_id(v_org_id, v_business_id, 'sales_revenue');
  END IF;
  v_tax_account     := public.get_default_account_id(v_org_id, v_business_id, 'pos_tax_payable');
  IF v_tax_account IS NULL THEN
    v_tax_account   := public.get_default_account_id(v_org_id, v_business_id, 'tax_payable');
  END IF;
  IF v_tax_account IS NULL THEN
    v_tax_account   := public.get_default_account_id(v_org_id, v_business_id, 'sales_tax_payable');
  END IF;

  IF v_cash_account IS NULL OR v_revenue_account IS NULL THEN
    RAISE EXCEPTION 'POS shift cannot post to GL: missing default account mapping. Configure ''pos_cash'' (or ''cash'') and ''pos_revenue'' (or ''sales_revenue'') in Settings > Default Accounts. shift_id=%', _shift_id;
  END IF;

  IF v_total_tax > 0 AND v_tax_account IS NULL THEN
    RAISE EXCEPTION 'POS shift has tax of % but no tax-payable account is mapped.', v_total_tax;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_cash_account, 'debit', v_total_sales, 'credit', 0, 'description', 'POS Cash/Card Receipts'),
    jsonb_build_object('account_id', v_revenue_account, 'debit', 0, 'credit', v_total_net, 'description', 'POS Sales Revenue')
  );
  IF v_total_tax > 0 AND v_tax_account IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_tax_account, 'debit', 0, 'credit', v_total_tax, 'description', 'POS Sales Tax Collected')
    );
  END IF;

  SELECT COALESCE(
    'JE-' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(entry_number, '[^0-9]', '', 'g'), ''))::int, 0) + 1)::text, 5, '0'),
    'JE-00001'
  ) INTO v_entry_number
  FROM public.journal_entries WHERE organization_id = v_org_id;

  -- Pass branch_id (16th positional arg) so JE lines are correctly attributed.
  v_jeid := public.post_journal_entry_atomic(
    v_org_id,
    v_business_id,
    v_entry_number,
    v_shift_date,
    v_reference,
    'POS Shift Close - aggregated GL posting',
    'pos_shift',
    _shift_id,
    v_shift.closed_by,
    false,
    false,
    v_lines,
    NULL,
    NULL,
    'main',
    v_branch_id
  );

  BEGIN
    UPDATE public.pos_shifts
    SET journal_entry_id = v_jeid,
        gl_posted_at = COALESCE(gl_posted_at, now())
    WHERE id = _shift_id;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  RETURN v_jeid;
END;
$function$;

-- ---- Fix 5: POS report RPCs gain optional p_branch_id filter ----
CREATE OR REPLACE FUNCTION public.get_pos_daily_sales(
  p_organization_id uuid,
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_register_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(sale_date date, total_amount numeric, transaction_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    (created_at AT TIME ZONE 'UTC')::date AS sale_date,
    SUM(total) AS total_amount,
    COUNT(*) AS transaction_count
  FROM pos_transactions
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id
    AND status = 'completed'
    AND transaction_type = 'sale'
    AND created_at >= p_date_from::timestamp
    AND created_at < (p_date_to + 1)::timestamp
    AND (p_register_id IS NULL OR register_id = p_register_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
  ORDER BY sale_date;
$$;

CREATE OR REPLACE FUNCTION public.get_pos_hourly_sales(
  p_organization_id uuid,
  p_business_id uuid,
  p_date date,
  p_register_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(sale_hour integer, total_amount numeric, transaction_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::integer AS sale_hour,
    SUM(total) AS total_amount,
    COUNT(*) AS transaction_count
  FROM pos_transactions
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id
    AND status = 'completed'
    AND transaction_type = 'sale'
    AND created_at >= p_date::timestamp
    AND created_at < (p_date + 1)::timestamp
    AND (p_register_id IS NULL OR register_id = p_register_id)
    AND (p_branch_id IS NULL OR branch_id = p_branch_id)
  GROUP BY EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::integer
  ORDER BY sale_hour;
$$;

CREATE OR REPLACE FUNCTION public.get_pos_top_products(
  p_organization_id uuid,
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_register_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(product_name text, total_quantity numeric, total_revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT
    ti.description AS product_name,
    SUM(ti.quantity) AS total_quantity,
    SUM(ti.line_total) AS total_revenue
  FROM pos_transaction_items ti
  JOIN pos_transactions t ON t.id = ti.transaction_id
  WHERE t.organization_id = p_organization_id
    AND t.business_id = p_business_id
    AND t.status = 'completed'
    AND t.transaction_type = 'sale'
    AND t.created_at >= p_date_from::timestamp
    AND t.created_at < (p_date_to + 1)::timestamp
    AND (p_register_id IS NULL OR t.register_id = p_register_id)
    AND (p_branch_id IS NULL OR t.branch_id = p_branch_id)
  GROUP BY ti.description
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.get_pos_dashboard_stats(
  _org_id uuid,
  _business_id uuid,
  _date date DEFAULT CURRENT_DATE,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  result jsonb;
  day_start timestamptz;
  day_end timestamptz;
BEGIN
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
          AND (t2.business_id = _business_id OR t2.business_id IS NULL)
          AND t2.status = 'completed'
          AND t2.transaction_type = 'sale'
          AND t2.created_at >= day_start
          AND t2.created_at < day_end
          AND (_branch_id IS NULL OR t2.branch_id = _branch_id)
        GROUP BY p.payment_method
      ) pm
    ), '[]'::jsonb)
  ) INTO result
  FROM pos_transactions t
  WHERE t.organization_id = _org_id
    AND (t.business_id = _business_id OR t.business_id IS NULL)
    AND t.status = 'completed'
    AND t.created_at >= day_start
    AND t.created_at < day_end
    AND (_branch_id IS NULL OR t.branch_id = _branch_id);

  RETURN COALESCE(result, jsonb_build_object(
    'today_sales', 0, 'today_transactions', 0, 'today_returns', 0,
    'today_returns_count', 0, 'average_basket', 0, 'payment_breakdown', '[]'::jsonb
  ));
END;
$$;

-- ---- Fix 7: Auto-seed default POS payment methods on business create ----
CREATE OR REPLACE FUNCTION public.seed_default_pos_payment_methods()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only seed if no methods yet for this business
  IF NOT EXISTS (
    SELECT 1 FROM public.pos_payment_methods WHERE business_id = NEW.id
  ) THEN
    INSERT INTO public.pos_payment_methods
      (organization_id, business_id, method_key, display_name, is_enabled, requires_reference, icon, sort_order)
    VALUES
      (NEW.organization_id, NEW.id, 'cash',          'Cash',           true,  false, 'Banknote',   1),
      (NEW.organization_id, NEW.id, 'card',          'Card',           true,  true,  'CreditCard', 2),
      (NEW.organization_id, NEW.id, 'mobile_money',  'Mobile Money',   true,  true,  'Smartphone', 3),
      (NEW.organization_id, NEW.id, 'bank_transfer', 'Bank Transfer',  false, true,  'Building',   4),
      (NEW.organization_id, NEW.id, 'voucher',       'Check/Voucher',  false, true,  'FileText',   5),
      (NEW.organization_id, NEW.id, 'credit',        'Store Credit',   false, false, 'Wallet',     6);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_pos_payment_methods ON public.businesses;
CREATE TRIGGER trg_seed_pos_payment_methods
AFTER INSERT ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.seed_default_pos_payment_methods();