CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(_org_id uuid, _business_id uuid, _report_type text, _as_of_date date, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(contact_id uuid, contact_name text, company text, email text, document_id uuid, document_number text, document_date date, due_date date, document_total numeric, applied_amount numeric, residual_amount numeric, days_overdue integer, bucket text, journal_entry_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ar_items AS (
    SELECT oi.contact_id, oi.document_id, oi.document_number, oi.document_date, oi.due_date,
           oi.document_total, (oi.paid_amount + oi.credited_amount) AS applied_amount,
           oi.base_residual_amount AS residual_amount,
           oi.days_past_due AS days_overdue,
           oi.aging_bucket AS bucket,
           oi.journal_entry_id
      FROM public.finance_ar_open_items_as_of(_org_id, _business_id, _branch_id, _as_of_date) oi
     WHERE _report_type = 'ar'
  ),
  ap_items AS (
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
    -- ADR 0136: this report is denominated in the base currency (the document
    -- rows carry base_residual_amount), so an unapplied credit must contribute
    -- its BASE amount. A foreign credit with no rate on file contributes NULL —
    -- an honest absence — never its face amount at a silent 1:1.
    SELECT cc.contact_id, cc.currency, cc.base_credit_amount AS credit_amount
      FROM public.finance_ar_customer_credit_as_of(_org_id, _business_id, _branch_id, _as_of_date) cc
     WHERE _report_type = 'ar'
    UNION ALL
    SELECT vc.contact_id, vc.currency, vc.base_credit_amount AS credit_amount
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of_date) vc
     WHERE _report_type = 'ap'
  ),
  credit_rows AS (
    SELECT
      cb.contact_id, c.name AS contact_name,
      CASE WHEN c.is_company THEN c.name ELSE NULL END AS company,
      c.email,
      cb.contact_id AS document_id,
      ('Unapplied credit (' || COALESCE(cb.currency, 'no currency on file') || ')')::text AS document_number,
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
END;
$function$;