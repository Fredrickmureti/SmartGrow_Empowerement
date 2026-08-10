CREATE OR REPLACE FUNCTION public.finance_aging_bucket(p_due_date date, p_as_of date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_due_date IS NULL THEN 'current'
    WHEN (p_as_of - p_due_date) < 0  THEN 'not_due'
    WHEN (p_as_of - p_due_date) <= 30 THEN 'current'
    WHEN (p_as_of - p_due_date) <= 60 THEN 'days30'
    WHEN (p_as_of - p_due_date) <= 90 THEN 'days60'
    ELSE 'days90'
  END
$$;

GRANT EXECUTE ON FUNCTION public.finance_aging_bucket(date, date) TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.get_ar_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
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
    SELECT COALESCE(SUM(ccb.balance), 0) AS amt
      FROM public.customer_credit_balances ccb
     WHERE ccb.organization_id = _org_id
       AND (_business_id IS NULL OR ccb.business_id = _business_id)
       AND ccb.balance > 0.01
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
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE bucket = 'not_due'),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE bucket = 'current') - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE bucket = 'days30'),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE bucket = 'days60'),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE bucket = 'days90'),
    (SELECT COUNT(*)::int FROM open_items WHERE bucket <> 'not_due'),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$function$;

CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  WITH open_bills AS (
    SELECT
      o.document_id   AS id,
      o.document_number,
      o.contact_id    AS vendor_id,
      o.due_date,
      o.residual_amount AS balance,
      public.finance_aging_bucket(o.due_date, p_as_of) AS bucket
    FROM public.finance_ap_open_items o
    WHERE o.organization_id = p_organization_id
      AND o.business_id     = p_business_id
      AND (p_branch_id IS NULL OR o.branch_id = p_branch_id)
      AND o.document_date <= p_as_of
      AND o.residual_amount > 0.01
  ),
  vendor_rows AS (
    SELECT
      ob.vendor_id,
      COALESCE(c.name, 'Unknown Vendor') AS vendor_name,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'not_due'), 0)::numeric AS not_due_amt,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'current'), 0)::numeric AS current_amt,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days30'),  0)::numeric AS d30,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days60'),  0)::numeric AS d60,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days90'),  0)::numeric AS d90,
      COALESCE(SUM(ob.balance), 0)::numeric                                      AS total_amt,
      jsonb_agg(
        jsonb_build_object(
          'id',          ob.id,
          'bill_number', COALESCE(ob.document_number, LEFT(ob.id::text, 8)),
          'due_date',    ob.due_date,
          'balance',     ob.balance,
          'bucket',      ob.bucket
        ) ORDER BY ob.due_date ASC NULLS LAST
      ) AS bills
    FROM open_bills ob
    LEFT JOIN public.contacts c ON c.id = ob.vendor_id
    GROUP BY ob.vendor_id, c.name
  )
  SELECT jsonb_build_object(
    'as_of',   p_as_of,
    'vendors', COALESCE(jsonb_agg(
      jsonb_build_object(
        'vendor_id',   vendor_id,
        'vendor_name', vendor_name,
        'not_due',     not_due_amt,
        'current',     current_amt,
        'days30',      d30,
        'days60',      d60,
        'days90',      d90,
        'total',       total_amt,
        'bills',       bills
      ) ORDER BY total_amt DESC
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'not_due',      COALESCE(SUM(not_due_amt), 0),
      'current',      COALESCE(SUM(current_amt), 0),
      'days30',       COALESCE(SUM(d30), 0),
      'days60',       COALESCE(SUM(d60), 0),
      'days90',       COALESCE(SUM(d90), 0),
      'total',        COALESCE(SUM(total_amt), 0),
      'vendor_count', COUNT(*)::int
    )
  ) INTO v_result
  FROM vendor_rows;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'totals', jsonb_build_object(
      'not_due',0,'current',0,'days30',0,'days60',0,'days90',0,'total',0,'vendor_count',0
    )
  ));
END$function$;