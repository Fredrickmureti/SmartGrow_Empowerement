
CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(
  _org_id uuid,
  _business_id uuid,
  _report_type text,
  _as_of_date date,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  contact_id uuid,
  contact_name text,
  company text,
  email text,
  document_id uuid,
  document_number text,
  document_date date,
  due_date date,
  document_total numeric,
  applied_amount numeric,
  residual_amount numeric,
  days_overdue integer,
  bucket text,
  journal_entry_id uuid
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ar_items AS (
    SELECT oi.contact_id, oi.document_id, oi.document_number, oi.document_date, oi.due_date,
           oi.document_total, oi.applied_amount, oi.base_residual_amount AS residual_amount,
           (_as_of_date - oi.due_date)::integer AS days_overdue,
           public.finance_aging_bucket(oi.due_date, _as_of_date) AS bucket,
           oi.journal_entry_id
      FROM public.finance_ar_open_items oi
     WHERE _report_type = 'ar'
       AND oi.organization_id = _org_id
       AND oi.business_id = _business_id
       AND oi.document_date <= _as_of_date
       AND (_branch_id IS NULL OR oi.branch_id = _branch_id)
       AND oi.residual_amount > 0.01
  ),
  ap_items AS (
    -- Single AP engine: point-in-time projection of the AP subledger.
    SELECT oi.contact_id, oi.document_id, oi.document_number, oi.document_date, oi.due_date,
           oi.document_total, (oi.paid_amount + oi.credited_amount) AS applied_amount,
           oi.base_residual_amount AS residual_amount,
           oi.days_past_due AS days_overdue,
           oi.aging_bucket AS bucket,
           oi.journal_entry_id
      FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of_date) oi
     WHERE _report_type = 'ap'
  ),
  open_items AS (
    SELECT * FROM ar_items
    UNION ALL
    SELECT * FROM ap_items
  ),
  positive_rows AS (
    SELECT
      oi.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email, oi.document_id, oi.document_number, oi.document_date, oi.due_date,
      oi.document_total, oi.applied_amount, oi.residual_amount,
      oi.days_overdue, oi.bucket, oi.journal_entry_id
    FROM open_items oi
    LEFT JOIN public.contacts c ON c.id = oi.contact_id
  ),
  credit_balances AS (
    SELECT cc.contact_id, cc.currency, cc.credit_amount
      FROM public.finance_ar_customer_credit cc
     WHERE _report_type = 'ar'
       AND cc.organization_id = _org_id
       AND cc.business_id = _business_id
    UNION ALL
    SELECT vc.contact_id, vc.currency, vc.credit_amount
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of_date) vc
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
  )
  SELECT * FROM positive_rows
  UNION ALL
  SELECT * FROM credit_rows
  ORDER BY 2 NULLS LAST, 8, 6;
$function$;
