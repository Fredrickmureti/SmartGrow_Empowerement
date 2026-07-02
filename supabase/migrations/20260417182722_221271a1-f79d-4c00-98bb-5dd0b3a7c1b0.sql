-- Recreate get_sales_dashboard_kpis using the actual membership model (user_roles via is_org_member)
-- and the actual credit_notes column (issue_date, not credit_note_date).
CREATE OR REPLACE FUNCTION public.get_sales_dashboard_kpis(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  result JSONB;
  v_now DATE := CURRENT_DATE;
BEGIN
  -- Verify caller belongs to org via the canonical membership model (user_roles)
  IF NOT public.is_org_member(auth.uid(), p_org_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  WITH
  all_inv AS (
    SELECT id, status, total, amount_paid, issue_date, due_date, contact_id
    FROM invoices
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
  ),
  period_inv AS (
    SELECT * FROM all_inv
    WHERE (p_date_from IS NULL OR issue_date >= p_date_from)
      AND (p_date_to IS NULL OR issue_date <= p_date_to)
  ),
  pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
      COUNT(*) FILTER (WHERE status IN ('sent', 'viewed')) AS sent_count,
      COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count,
      COUNT(*) FILTER (WHERE status = 'paid') AS paid_count_all
    FROM all_inv
  ),
  period_paid AS (
    SELECT COUNT(*) AS cnt FROM period_inv WHERE status = 'paid'
  ),
  receivable AS (
    SELECT
      COALESCE(SUM(total - amount_paid), 0) AS total_receivable,
      COALESCE(SUM(CASE WHEN status = 'overdue' THEN total - amount_paid ELSE 0 END), 0) AS overdue_amount,
      COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count
    FROM all_inv
    WHERE status IN ('sent', 'viewed', 'partial', 'overdue', 'confirmed')
      AND total - amount_paid > 0
  ),
  aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN v_now - due_date <= 0 THEN total - amount_paid ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN v_now - due_date BETWEEN 1 AND 30 THEN total - amount_paid ELSE 0 END), 0) AS days_1_30,
      COALESCE(SUM(CASE WHEN v_now - due_date BETWEEN 31 AND 60 THEN total - amount_paid ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN v_now - due_date BETWEEN 61 AND 90 THEN total - amount_paid ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN v_now - due_date > 90 THEN total - amount_paid ELSE 0 END), 0) AS days_90_plus
    FROM all_inv
    WHERE status IN ('sent', 'viewed', 'partial', 'overdue', 'confirmed')
      AND total - amount_paid > 0
  ),
  est AS (
    SELECT
      COUNT(*) AS total_estimates,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_estimates,
      COUNT(*) FILTER (WHERE status IN ('sent', 'draft')) AS open_estimates
    FROM estimates
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
      AND (p_date_from IS NULL OR created_at::date >= p_date_from)
      AND (p_date_to IS NULL OR created_at::date <= p_date_to)
  ),
  so AS (
    SELECT COUNT(*) AS pending_count
    FROM sales_orders
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
      AND status IN ('confirmed', 'draft')
  ),
  cn AS (
    SELECT
      COUNT(*) AS cn_count,
      COALESCE(SUM(total), 0) AS cn_total
    FROM credit_notes
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
      AND (p_date_from IS NULL OR issue_date >= p_date_from)
      AND (p_date_to IS NULL OR issue_date <= p_date_to)
  ),
  pay AS (
    SELECT
      COUNT(*) AS pay_count,
      COALESCE(SUM(amount), 0) AS pay_total
    FROM payments
    WHERE organization_id = p_org_id
      AND (p_business_id IS NULL OR business_id = p_business_id)
      AND COALESCE(status, '') <> 'voided'
      AND (p_date_from IS NULL OR payment_date >= p_date_from)
      AND (p_date_to IS NULL OR payment_date <= p_date_to)
  ),
  top_cust AS (
    SELECT COALESCE(jsonb_agg(row_to_json(tc)::jsonb), '[]'::jsonb) AS customers
    FROM (
      SELECT
        c.id AS contact_id,
        c.name,
        COUNT(pi.id) AS invoice_count,
        COALESCE(SUM(pi.total), 0) AS total_revenue
      FROM period_inv pi
      JOIN contacts c ON c.id = pi.contact_id
      WHERE pi.status = 'paid'
      GROUP BY c.id, c.name
      ORDER BY total_revenue DESC
      LIMIT 5
    ) tc
  ),
  recent_pay AS (
    SELECT COALESCE(jsonb_agg(row_to_json(rp)::jsonb), '[]'::jsonb) AS payments
    FROM (
      SELECT
        p.id,
        p.amount,
        p.payment_date,
        p.contact_id,
        c.name AS contact_name
      FROM payments p
      LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE p.organization_id = p_org_id
        AND (p_business_id IS NULL OR p.business_id = p_business_id)
        AND COALESCE(p.status, '') <> 'voided'
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT 5
    ) rp
  )
  SELECT jsonb_build_object(
    'pipeline', jsonb_build_object(
      'draft', (SELECT draft_count FROM pipeline),
      'sent', (SELECT sent_count FROM pipeline),
      'overdue', (SELECT overdue_count FROM pipeline),
      'paid', (SELECT paid_count_all FROM pipeline)
    ),
    'period_paid_count', (SELECT cnt FROM period_paid),
    'receivable', jsonb_build_object(
      'total', (SELECT total_receivable FROM receivable),
      'overdue_amount', (SELECT overdue_amount FROM receivable),
      'overdue_count', (SELECT overdue_count FROM receivable)
    ),
    'aging', jsonb_build_object(
      'current', (SELECT current_bucket FROM aging),
      'days_1_30', (SELECT days_1_30 FROM aging),
      'days_31_60', (SELECT days_31_60 FROM aging),
      'days_61_90', (SELECT days_61_90 FROM aging),
      'days_90_plus', (SELECT days_90_plus FROM aging)
    ),
    'estimates', jsonb_build_object(
      'total', (SELECT total_estimates FROM est),
      'accepted', (SELECT accepted_estimates FROM est),
      'open', (SELECT open_estimates FROM est)
    ),
    'sales_orders_pending', (SELECT pending_count FROM so),
    'credit_notes', jsonb_build_object(
      'count', (SELECT cn_count FROM cn),
      'total', (SELECT cn_total FROM cn)
    ),
    'payments', jsonb_build_object(
      'count', (SELECT pay_count FROM pay),
      'total', (SELECT pay_total FROM pay)
    ),
    'top_customers', (SELECT customers FROM top_cust),
    'recent_payments', (SELECT payments FROM recent_pay)
  ) INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_sales_dashboard_kpis(uuid, uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';