-- Wave 5: currency on the AR/AP open-items projections.
--
-- `invoices.total` / `bills.total` are DOCUMENT-currency amounts. Summing them
-- across currencies (aging, AR/AP summaries, tie-out) is arithmetically wrong.
-- Each row now also carries `currency`, `exchange_rate` and
-- `base_residual_amount` (residual converted to the business base currency).
-- Existing columns keep their exact meaning and position, so all current
-- consumers keep working; new consumers must sum `base_residual_amount`.

CREATE OR REPLACE VIEW public.finance_ar_open_items AS
WITH invoice_paid AS (
  SELECT pa.invoice_id, sum(pa.amount)::numeric(12,2) AS amount
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
   WHERE p.status IS DISTINCT FROM 'voided'
   GROUP BY pa.invoice_id
), invoice_credited AS (
  SELECT cna.invoice_id, sum(cna.amount)::numeric(12,2) AS amount
    FROM credit_note_applications cna
    JOIN credit_notes cn ON cn.id = cna.credit_note_id
   WHERE cn.status::text <> ALL (ARRAY['draft','cancelled','voided','void'])
   GROUP BY cna.invoice_id
), invoice_settled AS (
  SELECT inv.id AS invoice_id,
         (COALESCE(ip.amount,0) + COALESCE(ic.amount,0))::numeric(12,2) AS amount
    FROM invoices inv
    LEFT JOIN invoice_paid ip ON ip.invoice_id = inv.id
    LEFT JOIN invoice_credited ic ON ic.invoice_id = inv.id
), invoice_has_je AS (
  SELECT DISTINCT s.source_id AS invoice_id
    FROM ar_subledger_entries s
   WHERE s.source_type = 'invoice' AND s.source_id IS NOT NULL
), invoice_rows AS (
  SELECT inv.organization_id,
         inv.business_id,
         inv.branch_id,
         inv.id AS document_id,
         inv.invoice_number AS document_number,
         inv.contact_id,
         inv.issue_date AS document_date,
         inv.due_date,
         inv.total::numeric(12,2) AS document_total,
         COALESCE(isx.amount,0)::numeric(12,2) AS applied_amount,
         GREATEST(inv.total - COALESCE(isx.amount,0), 0)::numeric(12,2) AS residual_amount,
         inv.status::text AS document_status,
         inv.journal_entry_id,
         COALESCE(NULLIF(inv.currency,''), biz.base_currency, 'USD') AS currency,
         COALESCE(NULLIF(inv.exchange_rate,0), 1)::numeric(18,8) AS exchange_rate,
         (GREATEST(inv.total - COALESCE(isx.amount,0), 0)
            * COALESCE(NULLIF(inv.exchange_rate,0), 1))::numeric(14,2) AS base_residual_amount
    FROM invoices inv
    JOIN invoice_has_je ihj ON ihj.invoice_id = inv.id
    LEFT JOIN invoice_settled isx ON isx.invoice_id = inv.id
    LEFT JOIN businesses biz ON biz.id = inv.business_id
   WHERE (inv.status::text <> ALL (ARRAY['draft','cancelled','voided','paid']))
     AND (inv.total - COALESCE(isx.amount,0)) > 0.01
), manual_je_rows AS (
  -- Journal lines are always recorded in base currency.
  SELECT s.organization_id,
         s.business_id,
         s.branch_id,
         s.journal_entry_id AS document_id,
         max(s.entry_number) AS document_number,
         s.contact_id,
         min(s.entry_date) AS document_date,
         min(s.entry_date) AS due_date,
         sum(s.debit - s.credit)::numeric(12,2) AS document_total,
         0::numeric(12,2) AS applied_amount,
         sum(s.debit - s.credit)::numeric(12,2) AS residual_amount,
         'journal'::text AS document_status,
         s.journal_entry_id,
         COALESCE(max(biz.base_currency), 'USD') AS currency,
         1::numeric(18,8) AS exchange_rate,
         sum(s.debit - s.credit)::numeric(14,2) AS base_residual_amount
    FROM ar_subledger_entries s
    LEFT JOIN businesses biz ON biz.id = s.business_id
   WHERE s.contact_id IS NOT NULL
     AND (s.source_type IS NULL OR (s.source_type <> ALL (ARRAY['invoice','payment','customer_payment','credit_note','customer_refund','refund'])))
   GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING sum(s.debit - s.credit) > 0.01
)
SELECT organization_id, business_id, branch_id, document_id, document_number,
       contact_id, document_date, due_date, document_total, applied_amount,
       residual_amount, document_status, journal_entry_id,
       currency, exchange_rate, base_residual_amount
  FROM invoice_rows
UNION ALL
SELECT organization_id, business_id, branch_id, document_id, document_number,
       contact_id, document_date, due_date, document_total, applied_amount,
       residual_amount, document_status, journal_entry_id,
       currency, exchange_rate, base_residual_amount
  FROM manual_je_rows;

CREATE OR REPLACE VIEW public.finance_ap_open_items AS
WITH bill_paid AS (
  SELECT bpa.bill_id, sum(bpa.amount)::numeric(12,2) AS amount
    FROM bill_payment_allocations bpa
   GROUP BY bpa.bill_id
), bill_credited AS (
  SELECT vca.bill_id, sum(vca.amount)::numeric(12,2) AS amount
    FROM vendor_credit_note_applications vca
    JOIN vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
   WHERE vcn.status <> ALL (ARRAY['draft','cancelled','voided','void'])
   GROUP BY vca.bill_id
), bill_settled AS (
  SELECT b.id AS bill_id,
         (COALESCE(bp.amount,0) + COALESCE(bc.amount,0))::numeric(12,2) AS amount
    FROM bills b
    LEFT JOIN bill_paid bp ON bp.bill_id = b.id
    LEFT JOIN bill_credited bc ON bc.bill_id = b.id
), bill_has_je AS (
  SELECT DISTINCT s.source_id AS bill_id
    FROM ap_subledger_entries s
   WHERE s.source_type = 'bill' AND s.source_id IS NOT NULL
), bill_rows AS (
  SELECT b.organization_id,
         b.business_id,
         b.branch_id,
         b.id AS document_id,
         b.bill_number AS document_number,
         b.vendor_id AS contact_id,
         b.bill_date AS document_date,
         b.due_date,
         b.total AS document_total,
         COALESCE(bs.amount,0)::numeric(12,2) AS applied_amount,
         GREATEST(b.total - COALESCE(bs.amount,0), 0)::numeric(12,2) AS residual_amount,
         b.status::text AS document_status,
         (SELECT je.id FROM journal_entries je
           WHERE je.source_type = 'bill' AND je.source_id = b.id AND je.status = 'posted'
           ORDER BY je.entry_date, je.created_at LIMIT 1) AS journal_entry_id,
         COALESCE(NULLIF(b.currency,''), biz.base_currency, 'USD') AS currency,
         COALESCE(NULLIF(b.currency_rate,0), 1)::numeric(18,8) AS exchange_rate,
         (GREATEST(b.total - COALESCE(bs.amount,0), 0)
            * COALESCE(NULLIF(b.currency_rate,0), 1))::numeric(14,2) AS base_residual_amount
    FROM bills b
    JOIN bill_has_je bhj ON bhj.bill_id = b.id
    LEFT JOIN bill_settled bs ON bs.bill_id = b.id
    LEFT JOIN businesses biz ON biz.id = b.business_id
   WHERE (b.status::text <> ALL (ARRAY['draft','void','voided','cancelled','paid']))
     AND (b.total - COALESCE(bs.amount,0)) > 0.01
), manual_je_rows AS (
  SELECT s.organization_id,
         s.business_id,
         s.branch_id,
         s.journal_entry_id AS document_id,
         max(s.entry_number) AS document_number,
         s.contact_id,
         min(s.entry_date) AS document_date,
         min(s.entry_date) AS due_date,
         sum(s.credit - s.debit)::numeric(12,2) AS document_total,
         0::numeric(12,2) AS applied_amount,
         sum(s.credit - s.debit)::numeric(12,2) AS residual_amount,
         'journal'::text AS document_status,
         s.journal_entry_id,
         COALESCE(max(biz.base_currency), 'USD') AS currency,
         1::numeric(18,8) AS exchange_rate,
         sum(s.credit - s.debit)::numeric(14,2) AS base_residual_amount
    FROM ap_subledger_entries s
    LEFT JOIN businesses biz ON biz.id = s.business_id
   WHERE s.contact_id IS NOT NULL
     AND (s.source_type IS NULL OR (s.source_type <> ALL (ARRAY['bill','bill_payment','vendor_credit_note','vendor_refund'])))
   GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING sum(s.credit - s.debit) > 0.01
)
SELECT organization_id, business_id, branch_id, document_id, document_number,
       contact_id, document_date, due_date, document_total, applied_amount,
       residual_amount, document_status, journal_entry_id,
       currency, exchange_rate, base_residual_amount
  FROM bill_rows
UNION ALL
SELECT organization_id, business_id, branch_id, document_id, document_number,
       contact_id, document_date, due_date, document_total, applied_amount,
       residual_amount, document_status, journal_entry_id,
       currency, exchange_rate, base_residual_amount
  FROM manual_je_rows;

-- The GL is base currency, so the tie-out must compare base amounts.
CREATE OR REPLACE VIEW public.finance_open_items_tieout AS
WITH ar_proj AS (
  SELECT organization_id, business_id,
         sum(base_residual_amount)::numeric(14,2) AS projection_residual
    FROM finance_ar_open_items GROUP BY organization_id, business_id
), ar_ledger AS (
  SELECT organization_id, business_id,
         sum(debit - credit)::numeric(14,2) AS ledger_net
    FROM ar_subledger_entries GROUP BY organization_id, business_id
), ap_proj AS (
  SELECT organization_id, business_id,
         sum(base_residual_amount)::numeric(14,2) AS projection_residual
    FROM finance_ap_open_items GROUP BY organization_id, business_id
), ap_ledger AS (
  SELECT organization_id, business_id,
         sum(credit - debit)::numeric(14,2) AS ledger_net
    FROM ap_subledger_entries GROUP BY organization_id, business_id
)
SELECT 'ar'::text AS side,
       COALESCE(p.organization_id, l.organization_id) AS organization_id,
       COALESCE(p.business_id, l.business_id) AS business_id,
       COALESCE(p.projection_residual,0)::numeric(14,2) AS projection_residual,
       COALESCE(l.ledger_net,0)::numeric(14,2) AS ledger_net,
       (COALESCE(p.projection_residual,0) - COALESCE(l.ledger_net,0))::numeric(14,2) AS drift
  FROM ar_proj p
  FULL JOIN ar_ledger l ON l.organization_id = p.organization_id AND NOT l.business_id IS DISTINCT FROM p.business_id
UNION ALL
SELECT 'ap'::text AS side,
       COALESCE(p.organization_id, l.organization_id),
       COALESCE(p.business_id, l.business_id),
       COALESCE(p.projection_residual,0)::numeric(14,2),
       COALESCE(l.ledger_net,0)::numeric(14,2),
       (COALESCE(p.projection_residual,0) - COALESCE(l.ledger_net,0))::numeric(14,2)
  FROM ap_proj p
  FULL JOIN ap_ledger l ON l.organization_id = p.organization_id AND NOT l.business_id IS DISTINCT FROM p.business_id;