
-- Phase 1: Add gl_posting_mode POS setting
-- Phase 2: Composite indexes for POS scalability
-- Phase 2: RPC for atomic cash movement (fixes race condition)
-- Phase 2: Server-side POS report aggregation RPCs

-- 1. Composite indexes for POS query performance
CREATE INDEX IF NOT EXISTS idx_pos_transactions_shift_sync 
  ON pos_transactions (shift_id, synced_to_accounting) 
  WHERE synced_to_accounting = false;

CREATE INDEX IF NOT EXISTS idx_pos_transactions_org_biz_status_date 
  ON pos_transactions (organization_id, business_id, status, transaction_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_transaction_items_txn 
  ON pos_transaction_items (transaction_id);

CREATE INDEX IF NOT EXISTS idx_pos_transaction_payments_txn 
  ON pos_transaction_payments (transaction_id);

-- 2. Atomic cash movement RPC (fixes race condition)
CREATE OR REPLACE FUNCTION public.pos_add_cash_movement(
  p_organization_id uuid,
  p_shift_id uuid,
  p_register_id uuid,
  p_movement_type text,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement_id uuid;
  v_new_expected numeric;
BEGIN
  -- Insert the cash movement
  INSERT INTO pos_cash_movements (
    organization_id, shift_id, register_id, movement_type, amount, reason, notes, performed_by
  ) VALUES (
    p_organization_id, p_shift_id, p_register_id, p_movement_type, p_amount, p_reason, p_notes, p_performed_by
  ) RETURNING id INTO v_movement_id;

  -- Atomic update of expected_cash (no read-modify-write race)
  IF p_movement_type IN ('cash_in', 'float') THEN
    UPDATE pos_shifts 
    SET expected_cash = COALESCE(expected_cash, 0) + p_amount
    WHERE id = p_shift_id
    RETURNING expected_cash INTO v_new_expected;
  ELSIF p_movement_type IN ('cash_out', 'pickup') THEN
    UPDATE pos_shifts 
    SET expected_cash = COALESCE(expected_cash, 0) - p_amount
    WHERE id = p_shift_id
    RETURNING expected_cash INTO v_new_expected;
  END IF;

  RETURN json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'new_expected_cash', v_new_expected
  );
END;
$$;

-- 3. Server-side daily sales aggregation RPC
CREATE OR REPLACE FUNCTION public.get_pos_daily_sales(
  p_organization_id uuid,
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_register_id uuid DEFAULT NULL
)
RETURNS TABLE(sale_date date, total_amount numeric, transaction_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
  ORDER BY sale_date;
$$;

-- 4. Server-side hourly sales aggregation RPC
CREATE OR REPLACE FUNCTION public.get_pos_hourly_sales(
  p_organization_id uuid,
  p_business_id uuid,
  p_date date,
  p_register_id uuid DEFAULT NULL
)
RETURNS TABLE(sale_hour integer, total_amount numeric, transaction_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
  GROUP BY EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::integer
  ORDER BY sale_hour;
$$;

-- 5. Server-side top products aggregation RPC
CREATE OR REPLACE FUNCTION public.get_pos_top_products(
  p_organization_id uuid,
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_register_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 10
)
RETURNS TABLE(product_name text, total_quantity numeric, total_revenue numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
  GROUP BY ti.description
  ORDER BY total_revenue DESC
  LIMIT p_limit;
$$;

-- 6. Server-side shift summary RPC for session GL posting
CREATE OR REPLACE FUNCTION public.get_pos_shift_gl_summary(
  p_shift_id uuid
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result json;
  v_shift record;
  v_revenue json;
  v_payments json;
  v_tax_total numeric;
  v_cogs json;
  v_org_id uuid;
  v_biz_id uuid;
BEGIN
  -- Get shift info
  SELECT id, organization_id, business_id, shift_number, opened_at, closed_at
  INTO v_shift
  FROM pos_shifts
  WHERE id = p_shift_id;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'shift_not_found');
  END IF;

  v_org_id := v_shift.organization_id;
  v_biz_id := v_shift.business_id;

  -- Aggregate revenue by product sales_account_id (or null for default)
  SELECT json_agg(row_to_json(r))
  INTO v_revenue
  FROM (
    SELECT 
      p.sales_account_id,
      SUM(ti.line_total) AS total_amount
    FROM pos_transaction_items ti
    JOIN pos_transactions t ON t.id = ti.transaction_id
    LEFT JOIN products p ON p.id = ti.product_id
    WHERE t.shift_id = p_shift_id
      AND t.status = 'completed'
      AND t.transaction_type = 'sale'
      AND t.synced_to_accounting = false
    GROUP BY p.sales_account_id
  ) r;

  -- Aggregate payments by method
  SELECT json_agg(row_to_json(r))
  INTO v_payments
  FROM (
    SELECT 
      tp.payment_method,
      pm.debit_account_id,
      SUM(tp.amount) AS total_amount
    FROM pos_transaction_payments tp
    JOIN pos_transactions t ON t.id = tp.transaction_id
    LEFT JOIN pos_payment_methods pm 
      ON pm.organization_id = v_org_id AND pm.method_key = tp.payment_method
    WHERE t.shift_id = p_shift_id
      AND t.status = 'completed'
      AND t.transaction_type = 'sale'
      AND t.synced_to_accounting = false
    GROUP BY tp.payment_method, pm.debit_account_id
  ) r;

  -- Total tax
  SELECT COALESCE(SUM(tax_amount), 0)
  INTO v_tax_total
  FROM pos_transactions
  WHERE shift_id = p_shift_id
    AND status = 'completed'
    AND transaction_type = 'sale'
    AND synced_to_accounting = false;

  -- COGS aggregation for inventory products
  SELECT json_agg(row_to_json(r))
  INTO v_cogs
  FROM (
    SELECT 
      p.cogs_account_id,
      p.inventory_account_id,
      SUM(ti.quantity * COALESCE(p.cost_price, 0)) AS total_cogs
    FROM pos_transaction_items ti
    JOIN pos_transactions t ON t.id = ti.transaction_id
    JOIN products p ON p.id = ti.product_id
    WHERE t.shift_id = p_shift_id
      AND t.status = 'completed'
      AND t.transaction_type = 'sale'
      AND t.synced_to_accounting = false
      AND p.track_inventory = true
      AND p.cost_price > 0
    GROUP BY p.cogs_account_id, p.inventory_account_id
  ) r;

  RETURN json_build_object(
    'shift_id', v_shift.id,
    'organization_id', v_org_id,
    'business_id', v_biz_id,
    'shift_number', v_shift.shift_number,
    'revenue', COALESCE(v_revenue, '[]'::json),
    'payments', COALESCE(v_payments, '[]'::json),
    'tax_total', v_tax_total,
    'cogs', COALESCE(v_cogs, '[]'::json)
  );
END;
$$;
