
-- WAVE D.1: get_pos_x_report — require business_id
DROP FUNCTION IF EXISTS public.get_pos_x_report(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_pos_x_report(
  p_organization_id uuid,
  p_business_id uuid,
  p_shift_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result JSONB;
  v_shift RECORD;
  v_totals JSONB;
  v_payment_breakdown JSONB;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for POS X-Report' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses
    WHERE id = p_business_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'business % does not belong to organization %', p_business_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_shift
  FROM pos_shifts s
  WHERE s.id = p_shift_id
    AND s.organization_id = p_organization_id
    AND s.business_id = p_business_id;

  IF v_shift IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Shift not found in this Company');
  END IF;

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN transaction_type = 'sale' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_returns', COALESCE(SUM(CASE WHEN transaction_type = 'return' AND status = 'completed' THEN total ELSE 0 END), 0),
    'total_voids', COALESCE(SUM(CASE WHEN status = 'voided' THEN total ELSE 0 END), 0),
    'net_sales', COALESCE(SUM(CASE WHEN status='completed' AND transaction_type='sale' THEN total
                                    WHEN status='completed' AND transaction_type='return' THEN -total ELSE 0 END), 0),
    'total_tax', COALESCE(SUM(CASE WHEN status='completed' THEN tax_amount ELSE 0 END), 0),
    'total_discounts', COALESCE(SUM(CASE WHEN status='completed' THEN discount_amount ELSE 0 END), 0),
    'total_tips', COALESCE(SUM(CASE WHEN status='completed' THEN COALESCE(tip_amount,0) ELSE 0 END), 0),
    'transaction_count', COUNT(*) FILTER (WHERE status='completed'),
    'void_count', COUNT(*) FILTER (WHERE status='voided'),
    'return_count', COUNT(*) FILTER (WHERE transaction_type='return' AND status='completed')
  ) INTO v_totals
  FROM pos_transactions
  WHERE shift_id = p_shift_id AND business_id = p_business_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'payment_method', sub.payment_method,
    'total_amount', sub.total_amount,
    'transaction_count', sub.txn_count
  )), '[]'::JSONB) INTO v_payment_breakdown
  FROM (
    SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT p.transaction_id) AS txn_count
    FROM pos_transaction_payments p
    JOIN pos_transactions t ON t.id = p.transaction_id
    WHERE t.shift_id = p_shift_id
      AND t.business_id = p_business_id
      AND t.status = 'completed' AND p.status = 'completed'
    GROUP BY p.payment_method
  ) sub;

  v_result := jsonb_build_object(
    'shift_id', v_shift.id,
    'shift_number', v_shift.shift_number,
    'opened_at', v_shift.opened_at,
    'status', v_shift.status,
    'opening_cash', v_shift.opening_cash,
    'expected_cash', v_shift.expected_cash,
    'business_id', p_business_id,
    'totals', v_totals,
    'payment_breakdown', v_payment_breakdown,
    'generated_at', now()
  );
  RETURN v_result;
END;
$function$;

-- WAVE D.2: get_pos_z_report — require business_id
DROP FUNCTION IF EXISTS public.get_pos_z_report(uuid, date, uuid);

CREATE OR REPLACE FUNCTION public.get_pos_z_report(
  p_organization_id uuid,
  p_business_id uuid,
  p_date date DEFAULT CURRENT_DATE,
  p_register_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result JSONB; v_shifts JSONB; v_payment_breakdown JSONB; v_tax_summary JSONB; v_totals JSONB;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for POS Z-Report' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.businesses
    WHERE id = p_business_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'business % does not belong to organization %', p_business_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'shift_id', s.id, 'shift_number', s.shift_number, 'user_id', s.user_id,
    'opened_at', s.opened_at, 'closed_at', s.closed_at, 'status', s.status,
    'opening_cash', s.opening_cash, 'expected_cash', s.expected_cash,
    'actual_cash', s.actual_cash, 'cash_difference', s.cash_difference
  )), '[]'::JSONB) INTO v_shifts
  FROM pos_shifts s
  WHERE s.organization_id = p_organization_id
    AND s.business_id = p_business_id
    AND s.opened_at::DATE = p_date
    AND (p_register_id IS NULL OR s.register_id = p_register_id);

  SELECT jsonb_build_object(
    'total_sales', COALESCE(SUM(CASE WHEN transaction_type='sale' AND status='completed' THEN total ELSE 0 END),0),
    'total_returns', COALESCE(SUM(CASE WHEN transaction_type='return' AND status='completed' THEN total ELSE 0 END),0),
    'total_voids', COALESCE(SUM(CASE WHEN status='voided' THEN total ELSE 0 END),0),
    'net_sales', COALESCE(SUM(CASE WHEN status='completed' AND transaction_type='sale' THEN total
                                    WHEN status='completed' AND transaction_type='return' THEN -total ELSE 0 END),0),
    'total_tax', COALESCE(SUM(CASE WHEN status='completed' AND transaction_type='sale' THEN tax_amount ELSE 0 END),0),
    'total_discounts', COALESCE(SUM(CASE WHEN status='completed' THEN discount_amount ELSE 0 END),0),
    'total_tips', COALESCE(SUM(CASE WHEN status='completed' THEN COALESCE(tip_amount,0) ELSE 0 END),0),
    'transaction_count', COUNT(*) FILTER (WHERE status='completed'),
    'void_count', COUNT(*) FILTER (WHERE status='voided'),
    'return_count', COUNT(*) FILTER (WHERE transaction_type='return' AND status='completed'),
    'avg_transaction', CASE
      WHEN COUNT(*) FILTER (WHERE status='completed' AND transaction_type='sale') > 0
      THEN COALESCE(SUM(CASE WHEN status='completed' AND transaction_type='sale' THEN total ELSE 0 END),0)
           / COUNT(*) FILTER (WHERE status='completed' AND transaction_type='sale')
      ELSE 0 END
  ) INTO v_totals
  FROM pos_transactions t JOIN pos_shifts s ON s.id = t.shift_id
  WHERE t.organization_id = p_organization_id
    AND t.business_id = p_business_id
    AND s.opened_at::DATE = p_date
    AND (p_register_id IS NULL OR t.register_id = p_register_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'payment_method', tp.payment_method,
    'total_amount', tp.total_amount,
    'transaction_count', tp.txn_count
  )), '[]'::JSONB) INTO v_payment_breakdown
  FROM (
    SELECT p.payment_method, SUM(p.amount) AS total_amount, COUNT(DISTINCT p.transaction_id) AS txn_count
    FROM pos_transaction_payments p
    JOIN pos_transactions t ON t.id = p.transaction_id
    JOIN pos_shifts s ON s.id = t.shift_id
    WHERE t.organization_id = p_organization_id
      AND t.business_id = p_business_id
      AND s.opened_at::DATE = p_date
      AND t.status='completed' AND p.status='completed'
      AND (p_register_id IS NULL OR t.register_id = p_register_id)
    GROUP BY p.payment_method
  ) tp;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tax_rate', ti.tax_rate,
    'taxable_amount', ti.taxable_amount,
    'tax_amount', ti.tax_total
  )), '[]'::JSONB) INTO v_tax_summary
  FROM (
    SELECT i.tax_rate,
      SUM(i.line_total - i.tax_amount) AS taxable_amount,
      SUM(i.tax_amount) AS tax_total
    FROM pos_transaction_items i
    JOIN pos_transactions t ON t.id = i.transaction_id
    JOIN pos_shifts s ON s.id = t.shift_id
    WHERE t.organization_id = p_organization_id
      AND t.business_id = p_business_id
      AND s.opened_at::DATE = p_date
      AND t.status='completed'
      AND (p_register_id IS NULL OR t.register_id = p_register_id)
    GROUP BY i.tax_rate
    HAVING SUM(i.tax_amount) > 0
  ) ti;

  v_result := jsonb_build_object(
    'report_date', p_date, 'generated_at', now(),
    'organization_id', p_organization_id, 'business_id', p_business_id,
    'register_id', p_register_id,
    'shifts', v_shifts, 'totals', v_totals,
    'payment_breakdown', v_payment_breakdown, 'tax_summary', v_tax_summary
  );
  RETURN v_result;
END;
$function$;

-- WAVE D.3: GL strict mode — refuse cross-Company aggregation when >1 company
CREATE OR REPLACE FUNCTION public.get_general_ledger(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL,
  _account_ids uuid[] DEFAULT NULL,
  _include_zero_activity boolean DEFAULT false
)
RETURNS TABLE(
  account_id uuid, account_code text, account_name text, account_type text,
  opening_balance numeric, line_id uuid, entry_date date, entry_number text,
  je_description text, line_description text, reference text,
  debit numeric, credit numeric, source_type text, source_id uuid, contact_name text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_count int;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_general_ledger: _org_id is required';
  END IF;

  IF _business_id IS NULL THEN
    SELECT count(*) INTO v_business_count
    FROM public.businesses
    WHERE organization_id = _org_id AND COALESCE(is_active, true) = true;
    IF v_business_count > 1 THEN
      RAISE EXCEPTION 'Workspace has % active Companies. A specific business_id is required for the General Ledger. Use the consolidation report for cross-Company aggregation.', v_business_count
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           COALESCE(a.opening_balance, 0) AS opening_balance
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = true
      AND (_business_id IS NULL OR a.business_id = _business_id OR a.business_id IS NULL)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit - jel.credit), 0) AS prior_net
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date < _date_from
      AND (_business_id IS NULL OR je.business_id = _business_id)
    GROUP BY jel.account_id
  ),
  period_lines AS (
    SELECT
      jel.account_id, jel.id AS line_id,
      je.entry_date, je.entry_number,
      je.description AS je_description, jel.description AS line_description,
      je.reference, COALESCE(jel.debit,0) AS debit, COALESCE(jel.credit,0) AS credit,
      je.source_type, je.source_id, c.name AS contact_name
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.contacts c ON c.id = jel.contact_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id IS NULL OR je.business_id = _business_id)
  )
  SELECT
    s.id, s.code, s.name, s.account_type,
    (s.opening_balance + COALESCE(p.prior_net, 0)),
    pl.line_id, pl.entry_date, pl.entry_number, pl.je_description, pl.line_description,
    pl.reference, pl.debit, pl.credit, pl.source_type, pl.source_id, pl.contact_name
  FROM scope s
  LEFT JOIN prior p ON p.account_id = s.id
  LEFT JOIN period_lines pl ON pl.account_id = s.id
  WHERE _include_zero_activity
     OR pl.line_id IS NOT NULL
     OR (s.opening_balance + COALESCE(p.prior_net, 0)) <> 0
  ORDER BY s.code, pl.entry_date NULLS FIRST, pl.entry_number NULLS FIRST, pl.line_id NULLS FIRST;
END;
$function$;
