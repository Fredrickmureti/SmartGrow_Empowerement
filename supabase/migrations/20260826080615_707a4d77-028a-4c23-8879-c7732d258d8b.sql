-- Phase 9.0 (D1 residue): remove the silent 1:1 fallback from the two
-- salesperson-performance functions. Same rule already used by
-- finance_sales_analysis et al: public.fx_report_document_rate().

DROP FUNCTION IF EXISTS public.get_salesperson_performance(uuid, uuid, uuid, date, date);

CREATE FUNCTION public.get_salesperson_performance(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL::uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_date_from date DEFAULT NULL::date,
  p_date_to date DEFAULT NULL::date
)
RETURNS TABLE(
  salesperson_id uuid,
  salesperson_name text,
  gross_invoiced numeric,
  credit_notes_value numeric,
  net_revenue numeric,
  invoice_count bigint,
  orders_booked bigint,
  orders_value numeric,
  cash_collected numeric,
  outstanding numeric,
  overdue_amount numeric,
  pos_sales_value numeric,
  pos_sales_count bigint,
  has_foreign_currency boolean,
  unconvertible_document_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_today   date := CURRENT_DATE;
  v_from    date := COALESCE(p_date_from, '1900-01-01'::date);
  v_to      date := COALESCE(p_date_to, CURRENT_DATE);
  v_all     boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_org_member(v_user_id, p_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;

  v_all := public.has_role(v_user_id, p_org_id, 'owner'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'admin'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'accountant'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'super_admin'::app_role);

  RETURN QUERY
  WITH scoped_invoices AS (
    SELECT inv.id,
           inv.salesperson_id,
           inv.issue_date,
           COALESCE(NULLIF(inv.currency, ''), biz.base_currency) AS currency,
           biz.base_currency AS base_currency,
           public.fx_report_document_rate(inv.currency, inv.exchange_rate, biz.base_currency) AS fx_rate
      FROM public.invoices inv
      LEFT JOIN public.businesses biz ON biz.id = inv.business_id
     WHERE inv.organization_id = p_org_id
       AND (p_business_id IS NULL OR inv.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR inv.branch_id   = p_branch_id)
       AND inv.salesperson_id IS NOT NULL
       AND inv.status::text NOT IN ('draft', 'cancelled', 'voided')
  ),
  scoped_invoice_totals AS (
    SELECT si.*, (inv.total * si.fx_rate)::numeric AS base_total
      FROM scoped_invoices si
      JOIN public.invoices inv ON inv.id = si.id
  ),
  revenue AS (
    SELECT si.salesperson_id,
           SUM(si.base_total) FILTER (WHERE si.fx_rate IS NOT NULL)      AS gross_invoiced,
           COUNT(*) FILTER (WHERE si.fx_rate IS NOT NULL)                AS invoice_count,
           COUNT(*) FILTER (WHERE si.fx_rate IS NULL)                    AS unconvertible_invoices,
           bool_or(si.currency IS DISTINCT FROM si.base_currency)        AS fx
      FROM scoped_invoice_totals si
     WHERE si.issue_date BETWEEN v_from AND v_to
     GROUP BY si.salesperson_id
  ),
  credits AS (
    SELECT si.salesperson_id,
           SUM(cn.total * si.fx_rate) FILTER (WHERE si.fx_rate IS NOT NULL)::numeric AS credit_value,
           COUNT(*) FILTER (WHERE si.fx_rate IS NULL)                                AS unconvertible_credits
      FROM public.credit_notes cn
      JOIN public.invoices inv
        ON inv.id = COALESCE(cn.original_invoice_id, cn.invoice_id)
      JOIN scoped_invoices si ON si.id = inv.id
     WHERE cn.organization_id = p_org_id
       AND cn.status::text NOT IN ('draft', 'void', 'voided', 'cancelled')
       AND cn.issue_date BETWEEN v_from AND v_to
     GROUP BY si.salesperson_id
  ),
  scoped_orders AS (
    SELECT so.salesperson_id,
           so.total,
           public.fx_report_document_rate(so.currency, so.exchange_rate, biz.base_currency) AS fx_rate
      FROM public.sales_orders so
      LEFT JOIN public.businesses biz ON biz.id = so.business_id
     WHERE so.organization_id = p_org_id
       AND (p_business_id IS NULL OR so.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR so.branch_id   = p_branch_id)
       AND so.salesperson_id IS NOT NULL
       AND so.status NOT IN ('draft', 'cancelled')
       AND so.order_date BETWEEN v_from AND v_to
  ),
  orders AS (
    SELECT o.salesperson_id,
           COUNT(*) FILTER (WHERE o.fx_rate IS NOT NULL)                     AS orders_booked,
           SUM(o.total * o.fx_rate) FILTER (WHERE o.fx_rate IS NOT NULL)::numeric AS orders_value,
           COUNT(*) FILTER (WHERE o.fx_rate IS NULL)                         AS unconvertible_orders
      FROM scoped_orders o
     GROUP BY o.salesperson_id
  ),
  collections AS (
    SELECT si.salesperson_id,
           SUM(pa.amount * si.fx_rate) FILTER (WHERE si.fx_rate IS NOT NULL)::numeric AS cash_collected,
           COUNT(*) FILTER (WHERE si.fx_rate IS NULL)                                 AS unconvertible_receipts
      FROM public.payment_allocations pa
      JOIN public.payments pmt ON pmt.id = pa.payment_id
      JOIN public.invoices inv ON inv.id = pa.invoice_id
      JOIN scoped_invoices si  ON si.id = inv.id
     WHERE pmt.organization_id = p_org_id
       AND pmt.status IS DISTINCT FROM 'voided'
       AND pmt.voided_at IS NULL
       AND pmt.payment_date BETWEEN v_from AND v_to
     GROUP BY si.salesperson_id
  ),
  receivables AS (
    SELECT si.salesperson_id,
           SUM(oi.base_residual_amount)::numeric AS outstanding,
           SUM(oi.base_residual_amount) FILTER (
             WHERE public.finance_aging_bucket(oi.due_date, v_today) <> 'not_due'
           )::numeric AS overdue_amount
      FROM public.finance_ar_open_items oi
      JOIN scoped_invoices si ON si.id = oi.document_id
     WHERE oi.organization_id = p_org_id
       AND (p_business_id IS NULL OR oi.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR oi.branch_id   = p_branch_id)
       AND oi.document_date <= v_today
       AND oi.residual_amount > 0.01
     GROUP BY si.salesperson_id
  ),
  pos AS (
    SELECT pt.created_by AS salesperson_id,
           COUNT(*) AS pos_sales_count,
           SUM(pt.total)::numeric AS pos_sales_value
      FROM public.pos_transactions pt
     WHERE pt.organization_id = p_org_id
       AND (p_business_id IS NULL OR pt.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR pt.branch_id   = p_branch_id)
       AND pt.transaction_type = 'sale'
       AND pt.invoice_id IS NULL
       AND pt.voided_at IS NULL
       AND pt.created_by IS NOT NULL
       AND pt.created_at >= v_from::timestamptz
       AND pt.created_at <  (v_to + 1)::timestamptz
     GROUP BY pt.created_by
  ),
  people AS (
    SELECT r.salesperson_id FROM revenue r
    UNION SELECT c.salesperson_id FROM credits c
    UNION SELECT o.salesperson_id FROM orders o
    UNION SELECT cl.salesperson_id FROM collections cl
    UNION SELECT rc.salesperson_id FROM receivables rc
    UNION SELECT p.salesperson_id FROM pos p
  )
  SELECT
    pe.salesperson_id,
    COALESCE(NULLIF(pr.full_name, ''), pr.email, left(pe.salesperson_id::text, 8))::text,
    COALESCE(r.gross_invoiced, 0)::numeric,
    COALESCE(c.credit_value, 0)::numeric,
    (COALESCE(r.gross_invoiced, 0) - COALESCE(c.credit_value, 0))::numeric,
    COALESCE(r.invoice_count, 0)::bigint,
    COALESCE(o.orders_booked, 0)::bigint,
    COALESCE(o.orders_value, 0)::numeric,
    COALESCE(cl.cash_collected, 0)::numeric,
    COALESCE(rc.outstanding, 0)::numeric,
    COALESCE(rc.overdue_amount, 0)::numeric,
    COALESCE(p.pos_sales_value, 0)::numeric,
    COALESCE(p.pos_sales_count, 0)::bigint,
    COALESCE(r.fx, false),
    (COALESCE(r.unconvertible_invoices, 0)
     + COALESCE(c.unconvertible_credits, 0)
     + COALESCE(o.unconvertible_orders, 0)
     + COALESCE(cl.unconvertible_receipts, 0))::bigint
  FROM people pe
  LEFT JOIN revenue     r  ON r.salesperson_id  = pe.salesperson_id
  LEFT JOIN credits     c  ON c.salesperson_id  = pe.salesperson_id
  LEFT JOIN orders      o  ON o.salesperson_id  = pe.salesperson_id
  LEFT JOIN collections cl ON cl.salesperson_id = pe.salesperson_id
  LEFT JOIN receivables rc ON rc.salesperson_id = pe.salesperson_id
  LEFT JOIN pos         p  ON p.salesperson_id  = pe.salesperson_id
  LEFT JOIN public.profiles pr ON pr.user_id = pe.salesperson_id
  WHERE v_all OR pe.salesperson_id = v_user_id
  ORDER BY 5 DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_salesperson_performance(uuid, uuid, uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_salesperson_performance(uuid, uuid, uuid, date, date) TO authenticated, service_role;

-- Drill-down: an unconvertible document is listed with NO amount, never an invented one.
CREATE OR REPLACE FUNCTION public.get_salesperson_performance_documents(
  p_org_id uuid,
  p_salesperson_id uuid,
  p_metric text,
  p_business_id uuid DEFAULT NULL::uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_date_from date DEFAULT NULL::date,
  p_date_to date DEFAULT NULL::date
)
RETURNS TABLE(document_id uuid, document_kind text, document_number text, document_date date, contact_id uuid, contact_name text, amount numeric, status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_today   date := CURRENT_DATE;
  v_from    date := COALESCE(p_date_from, '1900-01-01'::date);
  v_to      date := COALESCE(p_date_to, CURRENT_DATE);
  v_all     boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_org_member(v_user_id, p_org_id) THEN
    RAISE EXCEPTION 'forbidden: not a member of this organization' USING ERRCODE = '42501';
  END IF;

  v_all := public.has_role(v_user_id, p_org_id, 'owner'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'admin'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'accountant'::app_role)
        OR public.has_role(v_user_id, p_org_id, 'super_admin'::app_role);

  IF NOT v_all AND p_salesperson_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'forbidden: cannot view another salesperson' USING ERRCODE = '42501';
  END IF;

  IF p_metric = 'revenue' THEN
    RETURN QUERY
    SELECT inv.id, 'invoice'::text, inv.invoice_number, inv.issue_date, inv.contact_id,
           ct.name::text,
           (inv.total * public.fx_report_document_rate(inv.currency, inv.exchange_rate, biz.base_currency))::numeric,
           inv.status::text
      FROM public.invoices inv
      LEFT JOIN public.businesses biz ON biz.id = inv.business_id
      LEFT JOIN public.contacts ct ON ct.id = inv.contact_id
     WHERE inv.organization_id = p_org_id
       AND (p_business_id IS NULL OR inv.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR inv.branch_id   = p_branch_id)
       AND inv.salesperson_id = p_salesperson_id
       AND inv.status::text NOT IN ('draft', 'cancelled', 'voided')
       AND inv.issue_date BETWEEN v_from AND v_to
     ORDER BY inv.issue_date DESC;

  ELSIF p_metric = 'credit' THEN
    RETURN QUERY
    SELECT cn.id, 'credit_note'::text, cn.credit_note_number, cn.issue_date, cn.contact_id,
           ct.name::text,
           (cn.total * public.fx_report_document_rate(inv.currency, inv.exchange_rate, biz.base_currency))::numeric,
           cn.status::text
      FROM public.credit_notes cn
      JOIN public.invoices inv ON inv.id = COALESCE(cn.original_invoice_id, cn.invoice_id)
      LEFT JOIN public.businesses biz ON biz.id = inv.business_id
      LEFT JOIN public.contacts ct ON ct.id = cn.contact_id
     WHERE cn.organization_id = p_org_id
       AND (p_business_id IS NULL OR inv.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR inv.branch_id   = p_branch_id)
       AND inv.salesperson_id = p_salesperson_id
       AND cn.status::text NOT IN ('draft', 'void', 'voided', 'cancelled')
       AND cn.issue_date BETWEEN v_from AND v_to
     ORDER BY cn.issue_date DESC;

  ELSIF p_metric = 'cash' THEN
    RETURN QUERY
    SELECT pmt.id, 'payment'::text, pmt.receipt_number, pmt.payment_date, pmt.contact_id,
           ct.name::text,
           (pa.amount * public.fx_report_document_rate(inv.currency, inv.exchange_rate, biz.base_currency))::numeric,
           COALESCE(pmt.status, 'recorded')::text
      FROM public.payment_allocations pa
      JOIN public.payments pmt ON pmt.id = pa.payment_id
      JOIN public.invoices inv ON inv.id = pa.invoice_id
      LEFT JOIN public.businesses biz ON biz.id = inv.business_id
      LEFT JOIN public.contacts ct ON ct.id = pmt.contact_id
     WHERE pmt.organization_id = p_org_id
       AND (p_business_id IS NULL OR inv.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR inv.branch_id   = p_branch_id)
       AND inv.salesperson_id = p_salesperson_id
       AND inv.status::text NOT IN ('draft', 'cancelled', 'voided')
       AND pmt.status IS DISTINCT FROM 'voided'
       AND pmt.voided_at IS NULL
       AND pmt.payment_date BETWEEN v_from AND v_to
     ORDER BY pmt.payment_date DESC;

  ELSIF p_metric = 'outstanding' THEN
    RETURN QUERY
    SELECT oi.document_id, 'invoice'::text, oi.document_number, oi.document_date, oi.contact_id,
           ct.name::text,
           oi.base_residual_amount::numeric,
           oi.document_status
      FROM public.finance_ar_open_items oi
      JOIN public.invoices inv ON inv.id = oi.document_id
      LEFT JOIN public.contacts ct ON ct.id = oi.contact_id
     WHERE oi.organization_id = p_org_id
       AND (p_business_id IS NULL OR oi.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR oi.branch_id   = p_branch_id)
       AND inv.salesperson_id = p_salesperson_id
       AND oi.document_date <= v_today
       AND oi.residual_amount > 0.01
     ORDER BY oi.due_date NULLS LAST;

  ELSIF p_metric = 'orders' THEN
    RETURN QUERY
    SELECT so.id, 'sales_order'::text, so.so_number, so.order_date, so.contact_id,
           ct.name::text,
           (so.total * public.fx_report_document_rate(so.currency, so.exchange_rate, biz.base_currency))::numeric,
           so.status
      FROM public.sales_orders so
      LEFT JOIN public.businesses biz ON biz.id = so.business_id
      LEFT JOIN public.contacts ct ON ct.id = so.contact_id
     WHERE so.organization_id = p_org_id
       AND (p_business_id IS NULL OR so.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR so.branch_id   = p_branch_id)
       AND so.salesperson_id = p_salesperson_id
       AND so.status NOT IN ('draft', 'cancelled')
       AND so.order_date BETWEEN v_from AND v_to
     ORDER BY so.order_date DESC;

  ELSIF p_metric = 'pos' THEN
    RETURN QUERY
    SELECT pt.id, 'pos_transaction'::text, pt.transaction_number, pt.created_at::date, pt.customer_id,
           COALESCE(pt.customer_name, 'Walk-in')::text,
           pt.total::numeric,
           COALESCE(pt.status, pt.payment_status, 'completed')::text
      FROM public.pos_transactions pt
     WHERE pt.organization_id = p_org_id
       AND (p_business_id IS NULL OR pt.business_id = p_business_id)
       AND (p_branch_id   IS NULL OR pt.branch_id   = p_branch_id)
       AND pt.created_by = p_salesperson_id
       AND pt.transaction_type = 'sale'
       AND pt.invoice_id IS NULL
       AND pt.voided_at IS NULL
       AND pt.created_at >= v_from::timestamptz
       AND pt.created_at <  (v_to + 1)::timestamptz
     ORDER BY pt.created_at DESC;
  END IF;
END;
$function$;
