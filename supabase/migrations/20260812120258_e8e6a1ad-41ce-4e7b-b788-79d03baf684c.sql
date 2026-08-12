-- Canonical definition of unapplied vendor (AP) credit, mirroring finance_ar_customer_credit.
CREATE OR REPLACE VIEW public.finance_ap_vendor_credit AS
  SELECT organization_id,
         business_id,
         vendor_id AS contact_id,
         currency,
         balance::numeric(14,2) AS credit_amount,
         public.to_base_amount(business_id, currency, balance, CURRENT_DATE)::numeric(14,2) AS base_credit_amount
    FROM public.vendor_credit_balances
   WHERE balance > 0.01;

GRANT SELECT ON public.finance_ap_vendor_credit TO authenticated;
GRANT ALL ON public.finance_ap_vendor_credit TO service_role;

-- Aging ledger: emit unapplied vendor credit as a never-aged negative residual for AP,
-- exactly as unapplied customer credit is emitted for AR.
CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(
  _org_id uuid, _business_id uuid, _report_type text, _as_of_date date, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(contact_id uuid, contact_name text, company text, email text, document_id uuid,
              document_number text, document_date date, due_date date, document_total numeric,
              applied_amount numeric, residual_amount numeric, days_overdue integer,
              bucket text, journal_entry_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  credit_balances AS (
    SELECT cc.organization_id, cc.business_id, cc.contact_id, cc.currency, cc.credit_amount
      FROM public.finance_ar_customer_credit cc
     WHERE _report_type = 'ar'
    UNION ALL
    SELECT vc.organization_id, vc.business_id, vc.contact_id, vc.currency, vc.credit_amount
      FROM public.finance_ap_vendor_credit vc
     WHERE _report_type = 'ap'
  ),
  credit_rows AS (
    SELECT
      cb.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email,
      cb.contact_id AS document_id,
      ('Unapplied credit (' || cb.currency || ')')::text AS document_number,
      _as_of_date AS document_date,
      _as_of_date AS due_date,
      (-cb.credit_amount)::numeric(12,2) AS document_total,
      0::numeric(12,2) AS applied_amount,
      (-cb.credit_amount)::numeric(12,2) AS residual_amount,
      0 AS days_overdue,
      'current'::text AS bucket,
      NULL::uuid AS journal_entry_id
    FROM credit_balances cb
    LEFT JOIN public.contacts c ON c.id = cb.contact_id
    WHERE cb.organization_id = _org_id
      AND cb.business_id = _business_id
  )
  SELECT * FROM positive_rows
  UNION ALL
  SELECT * FROM credit_rows
  ORDER BY 2 NULLS LAST, 8, 6;
$$;

-- AP summary: net unapplied vendor credit out of the total and the current bucket.
CREATE OR REPLACE FUNCTION public.get_ap_summary(
  _org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(open_document_count integer, total_residual numeric, not_due numeric,
              current_bucket numeric, days30 numeric, days60 numeric, days90 numeric,
              overdue_count integer, unposted_document_count integer, unposted_amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH open_items AS (
    SELECT o.*,
           GREATEST(0, (_as_of - COALESCE(o.due_date, o.document_date)))::int AS days_past_due
      FROM public.finance_ap_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  credits AS (
    SELECT COALESCE(SUM(vc.base_credit_amount), 0) AS amt
      FROM public.finance_ap_vendor_credit vc
     WHERE vc.organization_id = _org_id
       AND (_business_id IS NULL OR vc.business_id = _business_id)
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(b.total,0) - COALESCE(b.amount_paid,0))), 0) AS amt
      FROM public.bills b
     WHERE b.organization_id = _org_id
       AND (_business_id IS NULL OR b.business_id = _business_id)
       AND (_branch_id IS NULL OR b.branch_id = _branch_id)
       AND b.status::text NOT IN ('draft', 'submitted', 'approved', 'cancelled', 'voided', 'void', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'bill'
            AND je.source_id = b.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE COALESCE(due_date, document_date) > _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 0 AND 30 AND COALESCE(due_date, document_date) <= _as_of) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 31 AND 60),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 61 AND 90),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due > 90),
    (SELECT COUNT(*)::int FROM open_items WHERE COALESCE(due_date, document_date) < _as_of),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$$;

-- Aged payables report: per-vendor gross, credit and net; credit is never aged.
CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid, p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid, p_as_of date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  vendor_credit AS (
    SELECT vc.contact_id AS vendor_id,
           COALESCE(SUM(vc.base_credit_amount), 0)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit vc
     WHERE vc.organization_id = p_organization_id
       AND vc.business_id     = p_business_id
     GROUP BY vc.contact_id
  ),
  vendor_ids AS (
    SELECT vendor_id FROM open_bills
    UNION
    SELECT vendor_id FROM vendor_credit
  ),
  bill_rows AS (
    SELECT
      ob.vendor_id,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'not_due'), 0)::numeric AS not_due_amt,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'current'), 0)::numeric AS current_amt,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days30'),  0)::numeric AS d30,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days60'),  0)::numeric AS d60,
      COALESCE(SUM(ob.balance) FILTER (WHERE ob.bucket = 'days90'),  0)::numeric AS d90,
      COALESCE(SUM(ob.balance), 0)::numeric                                      AS gross_amt,
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
    GROUP BY ob.vendor_id
  ),
  vendor_rows AS (
    SELECT
      vi.vendor_id,
      COALESCE(c.name, 'Unknown Vendor') AS vendor_name,
      COALESCE(br.not_due_amt, 0) AS not_due_amt,
      COALESCE(br.current_amt, 0) - COALESCE(vcr.credit_amt, 0) AS current_amt,
      COALESCE(br.d30, 0) AS d30,
      COALESCE(br.d60, 0) AS d60,
      COALESCE(br.d90, 0) AS d90,
      COALESCE(br.gross_amt, 0) AS gross_amt,
      COALESCE(vcr.credit_amt, 0) AS credit_amt,
      COALESCE(br.gross_amt, 0) - COALESCE(vcr.credit_amt, 0) AS total_amt,
      COALESCE(br.bills, '[]'::jsonb) AS bills
    FROM vendor_ids vi
    LEFT JOIN bill_rows br ON br.vendor_id = vi.vendor_id
    LEFT JOIN vendor_credit vcr ON vcr.vendor_id = vi.vendor_id
    LEFT JOIN public.contacts c ON c.id = vi.vendor_id
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
        'gross',       gross_amt,
        'credit',      credit_amt,
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
      'gross',        COALESCE(SUM(gross_amt), 0),
      'credit',       COALESCE(SUM(credit_amt), 0),
      'total',        COALESCE(SUM(total_amt), 0),
      'vendor_count', COUNT(*)::int
    )
  ) INTO v_result
  FROM vendor_rows;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'totals', jsonb_build_object(
      'not_due',0,'current',0,'days30',0,'days60',0,'days90',0,
      'gross',0,'credit',0,'total',0,'vendor_count',0
    )
  ));
END
$$;

NOTIFY pgrst, 'reload schema';