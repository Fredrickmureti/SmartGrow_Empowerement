
-- 1. Dashboard stats RPC: replaces client-side aggregation in usePOSDashboardStats
CREATE OR REPLACE FUNCTION public.get_pos_dashboard_stats(
  _org_id uuid,
  _business_id uuid,
  _date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
        GROUP BY p.payment_method
      ) pm
    ), '[]'::jsonb)
  ) INTO result
  FROM pos_transactions t
  WHERE t.organization_id = _org_id
    AND (t.business_id = _business_id OR t.business_id IS NULL)
    AND t.status = 'completed'
    AND t.created_at >= day_start
    AND t.created_at < day_end;

  RETURN COALESCE(result, jsonb_build_object(
    'today_sales', 0, 'today_transactions', 0, 'today_returns', 0,
    'today_returns_count', 0, 'average_basket', 0, 'payment_breakdown', '[]'::jsonb
  ));
END;
$$;

-- 2. Shift report RPC: replaces client-side aggregation in usePOSReports.getShiftReport
CREATE OR REPLACE FUNCTION public.get_pos_shift_report_summary(
  _shift_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  shift_rec record;
BEGIN
  -- Get shift info
  SELECT * INTO shift_rec FROM pos_shifts WHERE id = _shift_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Shift not found');
  END IF;

  SELECT jsonb_build_object(
    'shift', jsonb_build_object(
      'id', shift_rec.id,
      'shift_number', shift_rec.shift_number,
      'opened_at', shift_rec.opened_at,
      'closed_at', shift_rec.closed_at,
      'opening_cash', shift_rec.opening_cash,
      'expected_cash', shift_rec.expected_cash,
      'actual_cash', shift_rec.actual_cash,
      'cash_difference', shift_rec.cash_difference,
      'status', shift_rec.status
    ),
    'sales', jsonb_build_object(
      'total', COALESCE(SUM(CASE WHEN t.transaction_type = 'sale' THEN t.total ELSE 0 END), 0),
      'count', COALESCE(COUNT(*) FILTER (WHERE t.transaction_type = 'sale'), 0),
      'returns', COALESCE(SUM(CASE WHEN t.transaction_type = 'return' THEN t.total ELSE 0 END), 0),
      'returns_count', COALESCE(COUNT(*) FILTER (WHERE t.transaction_type = 'return'), 0),
      'net', COALESCE(
        SUM(CASE WHEN t.transaction_type = 'sale' THEN t.total ELSE 0 END) -
        SUM(CASE WHEN t.transaction_type = 'return' THEN t.total ELSE 0 END), 0
      ),
      'by_payment_method', COALESCE((
        SELECT jsonb_object_agg(pm.payment_method, pm.total_amount)
        FROM (
          SELECT p.payment_method, SUM(p.amount) as total_amount
          FROM pos_transaction_payments p
          JOIN pos_transactions t2 ON t2.id = p.transaction_id
          WHERE t2.shift_id = _shift_id AND t2.status = 'completed'
          GROUP BY p.payment_method
        ) pm
      ), '{}'::jsonb)
    ),
    'cash_movements', jsonb_build_object(
      'cash_in', COALESCE((SELECT SUM(amount) FROM pos_cash_movements WHERE shift_id = _shift_id AND movement_type = 'cash_in'), 0),
      'cash_out', COALESCE((SELECT SUM(amount) FROM pos_cash_movements WHERE shift_id = _shift_id AND movement_type = 'cash_out'), 0),
      'floats', COALESCE((SELECT SUM(amount) FROM pos_cash_movements WHERE shift_id = _shift_id AND movement_type = 'float'), 0),
      'pickups', COALESCE((SELECT SUM(amount) FROM pos_cash_movements WHERE shift_id = _shift_id AND movement_type = 'pickup'), 0)
    ),
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', pi.description, 'quantity', pi.total_qty, 'revenue', pi.total_rev) ORDER BY pi.total_rev DESC)
      FROM (
        SELECT i.description, SUM(i.quantity) as total_qty, SUM(i.line_total) as total_rev
        FROM pos_transaction_items i
        JOIN pos_transactions t2 ON t2.id = i.transaction_id
        WHERE t2.shift_id = _shift_id AND t2.status = 'completed'
        GROUP BY i.description
        ORDER BY SUM(i.line_total) DESC
        LIMIT 10
      ) pi
    ), '[]'::jsonb)
  ) INTO result
  FROM pos_transactions t
  WHERE t.shift_id = _shift_id AND t.status = 'completed';

  RETURN result;
END;
$$;
