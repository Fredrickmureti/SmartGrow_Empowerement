DROP VIEW IF EXISTS public.finance_ar_open_items CASCADE;
DROP VIEW IF EXISTS public.finance_ap_open_items CASCADE;

-- ---------- AR ----------
CREATE VIEW public.finance_ar_open_items AS
WITH invoice_paid AS (
  SELECT pa.invoice_id, SUM(pa.amount)::numeric(12,2) AS amount
  FROM public.payment_allocations pa
  JOIN public.payments p ON p.id = pa.payment_id
  WHERE p.status IS DISTINCT FROM 'voided'
  GROUP BY pa.invoice_id
),
invoice_has_je AS (
  SELECT DISTINCT s.source_id AS invoice_id
  FROM public.ar_subledger_entries s
  WHERE s.source_type = 'invoice' AND s.source_id IS NOT NULL
),
invoice_rows AS (
  SELECT
    inv.organization_id,
    inv.business_id,
    inv.branch_id,
    inv.id AS document_id,
    inv.invoice_number AS document_number,
    inv.contact_id,
    inv.issue_date AS document_date,
    inv.due_date,
    inv.total::numeric(12,2) AS document_total,
    COALESCE(ip.amount, 0)::numeric(12,2) AS applied_amount,
    (inv.total - COALESCE(ip.amount, 0))::numeric(12,2) AS residual_amount,
    inv.status::text AS document_status,
    inv.journal_entry_id
  FROM public.invoices inv
  JOIN invoice_has_je ihj ON ihj.invoice_id = inv.id
  LEFT JOIN invoice_paid ip ON ip.invoice_id = inv.id
  WHERE inv.status::text NOT IN ('draft','cancelled','voided')
    AND (inv.total - COALESCE(ip.amount, 0)) > 0.01
),
manual_je_rows AS (
  SELECT
    s.organization_id,
    s.business_id,
    s.branch_id,
    s.journal_entry_id AS document_id,
    MAX(s.entry_number) AS document_number,
    s.contact_id,
    MIN(s.entry_date) AS document_date,
    MIN(s.entry_date) AS due_date,
    SUM(s.debit - s.credit)::numeric(12,2) AS document_total,
    0::numeric(12,2) AS applied_amount,
    SUM(s.debit - s.credit)::numeric(12,2) AS residual_amount,
    'journal'::text AS document_status,
    s.journal_entry_id
  FROM public.ar_subledger_entries s
  WHERE s.contact_id IS NOT NULL
    AND (s.source_type IS NULL
         OR s.source_type NOT IN ('invoice','payment','customer_payment','credit_note','customer_refund','refund'))
  GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING SUM(s.debit - s.credit) > 0.01
)
SELECT * FROM invoice_rows
UNION ALL
SELECT * FROM manual_je_rows;

-- ---------- AP ----------
CREATE VIEW public.finance_ap_open_items AS
WITH bill_paid AS (
  SELECT bpa.bill_id, SUM(bpa.amount)::numeric(12,2) AS amount
  FROM public.bill_payment_allocations bpa
  GROUP BY bpa.bill_id
),
bill_has_je AS (
  SELECT DISTINCT s.source_id AS bill_id
  FROM public.ap_subledger_entries s
  WHERE s.source_type = 'bill' AND s.source_id IS NOT NULL
),
bill_rows AS (
  SELECT
    b.organization_id,
    b.business_id,
    b.branch_id,
    b.id AS document_id,
    b.bill_number AS document_number,
    b.vendor_id AS contact_id,
    b.bill_date AS document_date,
    b.due_date,
    b.total::numeric(12,2) AS document_total,
    COALESCE(bp.amount, 0)::numeric(12,2) AS applied_amount,
    GREATEST(b.total - COALESCE(bp.amount, 0), 0)::numeric(12,2) AS residual_amount,
    b.status::text AS document_status,
    ( SELECT je.id FROM public.journal_entries je
       WHERE je.source_type = 'bill' AND je.source_id = b.id AND je.status = 'posted'
       ORDER BY je.entry_date, je.created_at LIMIT 1 ) AS journal_entry_id
  FROM public.bills b
  JOIN bill_has_je bhj ON bhj.bill_id = b.id
  LEFT JOIN bill_paid bp ON bp.bill_id = b.id
  WHERE b.status::text NOT IN ('draft','void')
    AND (b.total - COALESCE(bp.amount, 0)) > 0.01
),
manual_je_rows AS (
  SELECT
    s.organization_id,
    s.business_id,
    s.branch_id,
    s.journal_entry_id AS document_id,
    MAX(s.entry_number) AS document_number,
    s.contact_id,
    MIN(s.entry_date) AS document_date,
    MIN(s.entry_date) AS due_date,
    SUM(s.credit - s.debit)::numeric(12,2) AS document_total,
    0::numeric(12,2) AS applied_amount,
    SUM(s.credit - s.debit)::numeric(12,2) AS residual_amount,
    'journal'::text AS document_status,
    s.journal_entry_id
  FROM public.ap_subledger_entries s
  WHERE s.contact_id IS NOT NULL
    AND (s.source_type IS NULL
         OR s.source_type NOT IN ('bill','bill_payment','vendor_credit_note','vendor_refund'))
  GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING SUM(s.credit - s.debit) > 0.01
)
SELECT * FROM bill_rows
UNION ALL
SELECT * FROM manual_je_rows;

GRANT SELECT ON public.finance_ar_open_items TO authenticated, service_role;
GRANT SELECT ON public.finance_ap_open_items TO authenticated, service_role;