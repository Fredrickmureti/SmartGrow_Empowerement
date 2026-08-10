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

  v_recv_total       numeric := 0;
  v_recv_overdue_amt numeric := 0;
  v_recv_overdue_n   bigint  := 0;

  v_credit    numeric := 0;

  v_age_notdue numeric := 0;
  v_age_curr   numeric := 0;
  v_age_30     numeric := 0;
  v_age_60     numeric := 0;
  v_age_90     numeric := 0;

  v_est_total    bigint := 0;
  v_est_accepted bigint := 0;
  v_est_open     bigint := 0;

  v_so_pending bigint := 0;

  v_cn_count bigint  := 0;
  v_cn_total numeric := 0;

  v_pay_count bigint  := 0;
  v_pay_total numeric := 0;

  v_top_customers   jsonb := '[]'::jsonb;
  v_recent_payments jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_org_member(v_user_id, p_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE status = 'draft'),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed','partial','confirmed')),
    COUNT(*) FILTER (WHERE status = 'overdue'
                      OR (status IN ('sent','viewed','partial','confirmed')
                          AND due_date IS NOT NULL AND due_date < v_today
                          AND (total - COALESCE(amount_paid,0)) > 0)),
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

  -- Unapplied customer credit reduces the net receivable position.
  SELECT COALESCE(SUM(ccb.balance), 0)
  INTO v_credit
  FROM public.customer_credit_balances ccb
  WHERE ccb.organization_id = p_org_id
    AND (p_business_id IS NULL OR ccb.business_id = p_business_id)
    AND ccb.balance > 0.01;

  -- Receivable + aging come from the GL-anchored open-items projection so the
  -- dashboard cannot drift from the AR aging report (ADR-0027).
  WITH open_items AS (
    SELECT o.due_date,
           o.residual_amount AS bal,
           public.finance_aging_bucket(o.due_date, v_today) AS bucket
    FROM public.finance_ar_open_items o
    WHERE o.organization_id = p_org_id
      AND (p_business_id IS NULL OR o.business_id = p_business_id)
      AND (p_branch_id   IS NULL OR o.branch_id   = p_branch_id)
      AND o.document_date <= v_today
      AND o.residual_amount > 0.01
  )
  SELECT
    COALESCE(SUM(bal), 0),
    COALESCE(SUM(bal) FILTER (WHERE bucket <> 'not_due'), 0),
    COUNT(*) FILTER (WHERE bucket <> 'not_due'),
    COALESCE(SUM(bal) FILTER (WHERE bucket = 'not_due'), 0),
    COALESCE(SUM(bal) FILTER (WHERE bucket = 'current'), 0),
    COALESCE(SUM(bal) FILTER (WHERE bucket = 'days30'),  0),
    COALESCE(SUM(bal) FILTER (WHERE bucket = 'days60'),  0),
    COALESCE(SUM(bal) FILTER (WHERE bucket = 'days90'),  0)
  INTO v_recv_total, v_recv_overdue_amt, v_recv_overdue_n,
       v_age_notdue, v_age_curr, v_age_30, v_age_60, v_age_90
  FROM open_items;

  v_recv_total := v_recv_total - v_credit;
  v_age_curr   := v_age_curr   - v_credit;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'accepted'),
    COUNT(*) FILTER (WHERE status IN ('sent','viewed'))
  INTO v_est_total, v_est_accepted, v_est_open
  FROM public.estimates
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id);

  SELECT COUNT(*)
  INTO v_so_pending
  FROM public.sales_orders
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status NOT IN ('delivered','cancelled','invoiced','closed','completed');

  SELECT COUNT(*), COALESCE(SUM(total), 0)
  INTO v_cn_count, v_cn_total
  FROM public.credit_notes
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND status NOT IN ('draft','void')
    AND issue_date BETWEEN v_from AND v_to;

  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_pay_count, v_pay_total
  FROM public.payments
  WHERE organization_id = p_org_id
    AND (p_business_id IS NULL OR business_id = p_business_id)
    AND (p_branch_id   IS NULL OR branch_id   = p_branch_id)
    AND payment_date BETWEEN v_from AND v_to;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.total_revenue DESC), '[]'::jsonb)
  INTO v_top_customers
  FROM (
    SELECT i.contact_id,
           COALESCE(c.name, 'Unknown') AS name,
           COUNT(*)::bigint AS invoice_count,
           COALESCE(SUM(i.total), 0)::numeric AS total_revenue
    FROM public.invoices i
    LEFT JOIN public.contacts c ON c.id = i.contact_id
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
           c.name AS contact_name
    FROM public.payments p
    LEFT JOIN public.contacts c ON c.id = p.contact_id
    WHERE p.organization_id = p_org_id
      AND (p_business_id IS NULL OR p.business_id = p_business_id)
      AND (p_branch_id   IS NULL OR p.branch_id   = p_branch_id)
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
    'credit_notes', jsonb_build_object(
      'count', v_cn_count,
      'total', v_cn_total
    ),
    'payments', jsonb_build_object(
      'count', v_pay_count,
      'total', v_pay_total
    ),
    'top_customers',   v_top_customers,
    'recent_payments', v_recent_payments
  );
END;
$function$;