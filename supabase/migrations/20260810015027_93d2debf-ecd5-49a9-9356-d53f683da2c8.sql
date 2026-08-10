-- ============================================================
-- Wave 6: one definition of "unapplied customer credit", and a
-- server-side net receivable position per counterparty.
-- ============================================================

-- 1. Canonical unapplied customer credit.
CREATE OR REPLACE VIEW public.finance_ar_customer_credit
WITH (security_invoker = on) AS
  SELECT
    ccb.organization_id,
    ccb.business_id,
    ccb.contact_id,
    ccb.currency,
    (ccb.balance)::numeric(14,2)      AS credit_amount,
    -- Credit balances are held per currency. There is no rate on the balance
    -- row, so a balance already in the business base currency converts 1:1 and
    -- anything else is carried at face value until an FX policy exists for
    -- credit. Callers that sum across currencies must use base_credit_amount
    -- so the choice is made in one place, not per consumer.
    (ccb.balance)::numeric(14,2)      AS base_credit_amount
  FROM public.customer_credit_balances ccb
  WHERE ccb.balance > 0.01;

GRANT SELECT ON public.finance_ar_customer_credit TO anon, authenticated;
GRANT ALL    ON public.finance_ar_customer_credit TO service_role;

COMMENT ON VIEW public.finance_ar_customer_credit IS
  'Canonical unapplied customer credit (advance receipts / unapplied credit notes). Every read-side netting of receivables MUST read this view instead of customer_credit_balances directly.';

-- 2. Per-counterparty net AR position, bucketed on the server as of today.
CREATE OR REPLACE VIEW public.finance_ar_net_position
WITH (security_invoker = on) AS
  WITH items AS (
    SELECT
      o.organization_id, o.business_id, o.branch_id, o.contact_id,
      o.base_residual_amount AS amt,
      public.finance_aging_bucket(o.due_date, CURRENT_DATE) AS bucket,
      GREATEST(0, (CURRENT_DATE - COALESCE(o.due_date, o.document_date))::int) AS days_overdue
    FROM public.finance_ar_open_items o
    WHERE o.residual_amount > 0.01
      AND o.document_date <= CURRENT_DATE
  ),
  agg AS (
    SELECT
      organization_id, business_id, branch_id, contact_id,
      COUNT(*)::int                                                   AS open_document_count,
      COALESCE(SUM(amt), 0)::numeric(14,2)                            AS open_amount,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'not_due'), 0)::numeric(14,2) AS not_due,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'current'), 0)::numeric(14,2) AS current_bucket,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days30'),  0)::numeric(14,2) AS days30,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days60'),  0)::numeric(14,2) AS days60,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days90'),  0)::numeric(14,2) AS days90,
      COALESCE(MAX(days_overdue), 0)                                  AS max_days_overdue
    FROM items
    GROUP BY organization_id, business_id, branch_id, contact_id
  ),
  credit AS (
    SELECT organization_id, business_id, contact_id,
           COALESCE(SUM(base_credit_amount), 0)::numeric(14,2) AS credit_amount
    FROM public.finance_ar_customer_credit
    GROUP BY organization_id, business_id, contact_id
  )
  SELECT
    a.organization_id, a.business_id, a.branch_id, a.contact_id,
    c.name AS contact_name,
    a.open_document_count,
    a.open_amount,
    COALESCE(cr.credit_amount, 0)::numeric(14,2)                   AS credit_amount,
    (a.open_amount - COALESCE(cr.credit_amount, 0))::numeric(14,2) AS net_amount,
    a.not_due, a.current_bucket, a.days30, a.days60, a.days90,
    a.max_days_overdue
  FROM agg a
  LEFT JOIN credit cr
         ON cr.organization_id = a.organization_id
        AND cr.contact_id      = a.contact_id
        AND cr.business_id IS NOT DISTINCT FROM a.business_id
  LEFT JOIN public.contacts c ON c.id = a.contact_id
  -- finance_ar_open_items is owner-run, so scope this projection explicitly.
  WHERE public.is_org_member(auth.uid(), a.organization_id);

GRANT SELECT ON public.finance_ar_net_position TO authenticated;
GRANT ALL    ON public.finance_ar_net_position TO service_role;

COMMENT ON VIEW public.finance_ar_net_position IS
  'Per-counterparty net receivable position as of today: base-currency open amount bucketed by age, less unapplied credit. Read-side surfaces (top exposures, collections work lists) MUST read this instead of bucketing/netting in application code.';

-- 3. Repoint the three SQL netting sites at the canonical credit view, and
--    sum base-currency residuals so multi-currency businesses add up.
CREATE OR REPLACE FUNCTION public.get_ar_summary(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(open_document_count integer, total_residual numeric, not_due numeric, current_bucket numeric, days30 numeric, days60 numeric, days90 numeric, overdue_count integer, unposted_document_count integer, unposted_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH open_items AS (
    SELECT o.*, public.finance_aging_bucket(o.due_date, _as_of) AS bucket
      FROM public.finance_ar_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  credits AS (
    SELECT COALESCE(SUM(cc.base_credit_amount), 0) AS amt
      FROM public.finance_ar_customer_credit cc
     WHERE cc.organization_id = _org_id
       AND (_business_id IS NULL OR cc.business_id = _business_id)
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(i.total,0) - COALESCE(i.amount_paid,0))), 0) AS amt
      FROM public.invoices i
     WHERE i.organization_id = _org_id
       AND (_business_id IS NULL OR i.business_id = _business_id)
       AND (_branch_id IS NULL OR i.branch_id = _branch_id)
       AND i.status NOT IN ('draft', 'cancelled', 'voided', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'invoice'
            AND je.source_id = i.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'not_due'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'current') - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days30'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days60'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days90'),
    (SELECT COUNT(*)::int FROM open_items WHERE bucket <> 'not_due'),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$function$;

CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(_org_id uuid, _business_id uuid, _report_type text, _as_of_date date, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(contact_id uuid, contact_name text, company text, email text, document_id uuid, document_number text, document_date date, due_date date, document_total numeric, applied_amount numeric, residual_amount numeric, days_overdue integer, bucket text, journal_entry_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH open_items AS (
    SELECT * FROM public.finance_ar_open_items WHERE _report_type = 'ar'
    UNION ALL
    SELECT * FROM public.finance_ap_open_items WHERE _report_type = 'ap'
  ),
  positive_rows AS (
    SELECT
      oi.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email, oi.document_id, oi.document_number, oi.document_date, oi.due_date,
      oi.document_total, oi.applied_amount, oi.residual_amount,
      (_as_of_date - oi.due_date)::integer AS days_overdue,
      public.finance_aging_bucket(oi.due_date, _as_of_date) AS bucket,
      oi.journal_entry_id
    FROM open_items oi
    LEFT JOIN public.contacts c ON c.id = oi.contact_id
    WHERE oi.organization_id = _org_id
      AND oi.business_id = _business_id
      AND oi.document_date <= _as_of_date
      AND (_branch_id IS NULL OR oi.branch_id = _branch_id)
      AND oi.residual_amount > 0.01
  ),
  credit_rows AS (
    SELECT
      cc.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email,
      cc.contact_id AS document_id,
      ('Unapplied credit (' || cc.currency || ')')::text AS document_number,
      _as_of_date AS document_date,
      _as_of_date AS due_date,
      (-cc.credit_amount)::numeric(12,2) AS document_total,
      0::numeric(12,2) AS applied_amount,
      (-cc.credit_amount)::numeric(12,2) AS residual_amount,
      0 AS days_overdue,
      'current'::text AS bucket,
      NULL::uuid AS journal_entry_id
    FROM public.finance_ar_customer_credit cc
    LEFT JOIN public.contacts c ON c.id = cc.contact_id
    WHERE _report_type = 'ar'
      AND cc.organization_id = _org_id
      AND cc.business_id = _business_id
  )
  SELECT * FROM positive_rows
  UNION ALL
  SELECT * FROM credit_rows
  ORDER BY 2 NULLS LAST, 8, 6;
$function$;
