CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(
  _org_id uuid, _business_id uuid, _report_type text, _as_of_date date, _branch_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(contact_id uuid, contact_name text, company text, email text,
  document_id uuid, document_number text, document_date date, due_date date,
  document_total numeric, applied_amount numeric, residual_amount numeric,
  days_overdue integer, bucket text, journal_entry_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
      CASE
        WHEN (_as_of_date - oi.due_date)::integer < 0 THEN 'not_due'
        WHEN (_as_of_date - oi.due_date)::integer <= 30 THEN 'current'
        WHEN (_as_of_date - oi.due_date)::integer <= 60 THEN 'days30'
        WHEN (_as_of_date - oi.due_date)::integer <= 90 THEN 'days60'
        ELSE 'days90'
      END AS bucket,
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
      ccb.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email,
      ccb.id AS document_id,
      ('Unapplied credit (' || ccb.currency || ')')::text AS document_number,
      _as_of_date AS document_date,
      _as_of_date AS due_date,
      (-ccb.balance)::numeric(12,2) AS document_total,
      0::numeric(12,2) AS applied_amount,
      (-ccb.balance)::numeric(12,2) AS residual_amount,
      0 AS days_overdue,
      'current'::text AS bucket,
      NULL::uuid AS journal_entry_id
    FROM public.customer_credit_balances ccb
    LEFT JOIN public.contacts c ON c.id = ccb.contact_id
    WHERE _report_type = 'ar'
      AND ccb.organization_id = _org_id
      AND ccb.business_id = _business_id
      AND ccb.balance > 0.01
  )
  SELECT * FROM positive_rows
  UNION ALL
  SELECT * FROM credit_rows
  ORDER BY 2 NULLS LAST, 8, 6;
$function$;