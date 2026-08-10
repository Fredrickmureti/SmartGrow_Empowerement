CREATE OR REPLACE FUNCTION public.get_sales_dashboard_kpis(p_org_id uuid, p_business_id uuid, p_date_from date, p_date_to date, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_today   date := CURRENT_DATE;
  v_from    date := COALESCE(p_date_from, '1900-01-01'::date);
  v_to      date := COALESCE(p_date_to, v_today);

  v_draft_n   bigint := 0;
  v_sent_n    bigint := 0;
  v_overdue_n bigint := 0;
  v_paid_n    bigint := 0;

  v_period_paid_n bigint := 0;

  v_recv_open        numeric := 0;
  v_recv_total       numeric := 0;
  v_recv_overdue_amt numeric := 0;
  v_recv_overdue_n   bigint  := 0;

  v_credit    numeric := 0;

  v_age_notdue numeric := 0;
  v_age_curr   numeric := 0;
  v_age_30     numeric := 0;
  v_age_60     numeric := 0;
  v_age_90     numeric := 0;

  v_currency_n  bigint  := 0;
  v_mixed       boolean := false;

  v_est_total    bigint := 0;
  v_est_accepted bigint := 0;
  v_est_open     bigint := 0;

  v_so_pending bigint := 0;
  v_so_partial bigint := 0;

  v_cn_count bigint  := 0;
  v_cn_total numeric := 0;

  v_pay_count     bigint  := 0;
  v_pay_total     numeric := 0;
  v_pay_applied   numeric := 0;
  v_pay_unapplied numeric := 0;

  v_top_customers   jsonb := '[]'::jsonb;
  v_recent_payments jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_org_member(v_user_id, p_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;

  -- Invoice pipeline (open/overdue derived from residual, not from a label).
  SELECT
    COUNT(*) FILTER (WHERE status = 'draft'),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed','partial','confirmed')),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed','partial','confirmed','overdue')
                      AND due_date IS NOT NULL AND due_date < v_today
                      AND (total - COALESCE(amount_paid,0)) > 0.01),
    COUNT(*) FILTER (WHERE status = 'paid')
  INTO v_draft_n, v_sent_n, v_overdue_n, v_paid_n
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status NOT IN ('cancelled','voided');

  SELECT COUNT(*)
  INTO v_period_paid_n
  FROM public.invoices
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status = 'paid'
    AND issue_date BETWEEN v_from AND v_to;

  -- Receivable + aging: canonical net-position projection (base currency,
  -- credit-netted, aged as of today). No local bucketing, no currency mixing.
  SELECT
    COALESCE(SUM(np.open_amount), 0),
    COALESCE(SUM(np.credit_amount), 0),
    COALESCE(SUM(np.net_amount), 0),
    COALESCE(SUM(np.current_bucket + np.days30 + np.days60 + np.days90), 0),
    COALESCE(SUM(np.not_due), 0),
    COALESCE(SUM(np.current_bucket), 0),
    COALESCE(SUM(np.days30), 0),
    COALESCE(SUM(np.days60), 0),
    COALESCE(SUM(np.days90), 0)
  INTO v_recv_open, v_credit, v_recv_total, v_recv_overdue_amt,
       v_age_notdue, v_age_curr, v_age_30, v_age_60, v_age_90
  FROM public.finance_ar_net_position np
  WHERE np.organization_id = p_org_id
    AND (p_business_id IS NULL OR np.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR np.branch_id   = p_branch_id);

  SELECT COUNT(*)
  INTO v_recv_overdue_n
  FROM public.finance_ar_open_items o
  WHERE o.organization_id = p_org_id
    AND (p_business_id IS NULL OR o.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR o.branch_id   = p_branch_id)
    AND o.base_residual_amount > 0.01
    AND o.due_date IS NOT NULL
    AND o.due_date < v_today;

  SELECT COUNT(DISTINCT c.currency)
  INTO v_currency_n
  FROM public.finance_ar_net_position_by_currency c
  WHERE c.organization_id = p_org_id
    AND (p_business_id IS NULL OR c.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR c.branch_id   = p_branch_id);
  v_mixed := COALESCE(v_currency_n, 0) > 1;

  -- Quote conversion: period cohort; 'converted' AND 'accepted' are both won.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status IN ('accepted','converted')),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed'))
  INTO v_est_total, v_est_accepted, v_est_open
  FROM public.estimates
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status <> 'draft'
    AND issue_date BETWEEN v_from AND v_to;

  -- Orders to fulfil: line-level open quantities, not a status list.
  SELECT
    COUNT(DISTINCT b.sales_order_id) FILTER (WHERE b.quantity_open_to_deliver > 0),
    COUNT(DISTINCT b.sales_order_id) FILTER (WHERE b.quantity_open_to_deliver > 0
                                              AND COALESCE(b.quantity_delivered,0) > 0)
  INTO v_so_pending, v_so_partial
  FROM public.so_line_balances b
  WHERE b.organization_id = p_org_id
    AND (p_business_id IS NULL OR b.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR b.branch_id   = p_branch_id)
    AND b.order_status NOT IN ('draft','cancelled');

  SELECT COUNT(*), COALESCE(SUM(total), 0)
  INTO v_cn_count, v_cn_total
  FROM public.credit_notes
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status NOT IN ('draft','void','voided','cancelled')
    AND issue_date BETWEEN v_from AND v_to;

  -- Cash: allocation-first (ADR 0027). Voided/unreconciled payments excluded.
  SELECT COUNT(*), COALESCE(SUM(p.amount), 0), COALESCE(SUM(p.applied_amount), 0)
  INTO v_pay_count, v_pay_total, v_pay_applied
  FROM public.payments p
  WHERE p.organization_id = p_org_id
    AND (p_business_id IS NULL OR p.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR p.branch_id   = p_branch_id)
    AND COALESCE(p.status,'') NOT IN ('voided','void','cancelled','unreconciled','failed','draft')
    AND p.payment_date BETWEEN v_from AND v_to;

  SELECT COALESCE(SUM(pa.amount), 0)
  INTO v_pay_applied
  FROM public.payment_allocations pa
  JOIN public.payments p ON p.id = pa.payment_id
  WHERE p.organization_id = p_org_id
    AND (p_business_id IS NULL OR p.business_id = p_business_id)
    AND (p_branch_id   IS NULL OR p.branch_id   = p_branch_id)
    AND COALESCE(p.status,'') NOT IN ('voided','void','cancelled','unreconciled','failed','draft')
    AND p.payment_date BETWEEN v_from AND v_to;

  v_pay_unapplied := GREATEST(v_pay_total - v_pay_applied, 0);

  -- Top customers: invoiced net of applied credit notes.
  SELECT COALESCE(jsonb_agg(t ORDER BY t.total_revenue DESC), '[]'::jsonb)
  INTO v_top_customers
  FROM (
    SELECT i.contact_id,
           COALESCE(c.name, 'Unknown') AS name,
           COUNT(*)::bigint AS invoice_count,
           GREATEST(COALESCE(SUM(i.total), 0) - COALESCE(SUM(cn.applied), 0), 0)::numeric AS total_revenue
    FROM public.invoices i
    LEFT JOIN public.contacts c ON c.id = i.contact_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount), 0) AS applied
      FROM public.credit_note_applications a
      JOIN public.credit_notes n ON n.id = a.credit_note_id
      WHERE a.invoice_id = i.id
        AND n.status NOT IN ('draft','void','voided','cancelled')
    ) cn ON true
    WHERE i.organization_id = p_org_id
      AND (p_business_id IS NULL OR i.business_id = p_business_id)
      AND (p_branch_id   IS NULL OR i.branch_id   = p_branch_id)
      AND i.status NOT IN ('cancelled','voided','draft')
      AND i.issue_date BETWEEN v_from AND v_to
      AND i.contact_id IS NOT NULL
    GROUP BY i.contact_id, c.name
    ORDER BY total_revenue DESC
    LIMIT 5
  ) t;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.payment_date DESC), '[]'::jsonb)
  INTO v_recent_payments
  FROM (
    SELECT p.id, p.amount, p.payment_date, p.contact_id,
           COALESCE(p.applied_amount, 0) AS applied_amount,
           c.name AS contact_name
    FROM public.payments p
    LEFT JOIN public.contacts c ON c.id = p.contact_id
    WHERE p.organization_id = p_org_id
      AND (p_business_id IS NULL OR p.business_id = p_business_id)
      AND (p_branch_id   IS NULL OR p.branch_id   = p_branch_id)
      AND COALESCE(p.status,'') NOT IN ('voided','void','cancelled','unreconciled','failed','draft')
      AND p.payment_date BETWEEN v_from AND v_to
    ORDER BY p.payment_date DESC, p.created_at DESC
    LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'pipeline', jsonb_build_object(
      'draft',   v_draft_n,
      'sent',    v_sent_n,
      'overdue', v_overdue_n,
      'paid',    v_paid_n
    ),
    'period_paid_count', v_period_paid_n,
    'receivable', jsonb_build_object(
      'total',           v_recv_total,
      'open_amount',     v_recv_open,
      'overdue_amount',  v_recv_overdue_amt,
      'overdue_count',   v_recv_overdue_n,
      'credit_balance',  v_credit
    ),
    'aging', jsonb_build_object(
      'not_due', v_age_notdue,
      'current', v_age_curr,
      'days30',  v_age_30,
      'days60',  v_age_60,
      'days90',  v_age_90
    ),
    'estimates', jsonb_build_object(
      'total',    v_est_total,
      'accepted', v_est_accepted,
      'open',     v_est_open
    ),
    'sales_orders_pending', v_so_pending,
    'sales_orders_partial', v_so_partial,
    'credit_notes', jsonb_build_object(
      'count', v_cn_count,
      'total', v_cn_total
    ),
    'payments', jsonb_build_object(
      'count',     v_pay_count,
      'total',     v_pay_total,
      'applied',   v_pay_applied,
      'unapplied', v_pay_unapplied
    ),
    'top_customers',   v_top_customers,
    'recent_payments', v_recent_payments,
    'meta', jsonb_build_object(
      'as_of', v_today,
      'period_from', v_from,
      'period_to', v_to,
      'mixed_currency', v_mixed,
      'currency_count', COALESCE(v_currency_n, 0),
      'basis', jsonb_build_object(
        'revenue', 'period',
        'payments', 'period',
        'credit_notes', 'period',
        'estimates', 'period',
        'receivable', 'as_of',
        'aging', 'as_of',
        'pipeline', 'as_of',
        'sales_orders_pending', 'as_of'
      )
    )
  );
END;
$function$;