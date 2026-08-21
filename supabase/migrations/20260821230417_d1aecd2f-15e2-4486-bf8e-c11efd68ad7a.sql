-- ADR 0136: a missing rate is an absence, never 1:1.
-- `finance_ar_open_items` previously carried COALESCE(NULLIF(exchange_rate,0),1)
-- and a literal 'USD' fallback, so a foreign invoice with no stamped rate was
-- reported in base currency at face value. base_residual_amount now propagates
-- NULL for such a document; a same-currency document still resolves to 1
-- because that is an identity, not an invented rate.
CREATE OR REPLACE VIEW public.finance_ar_open_items AS
 WITH invoice_paid AS (
         SELECT pa.invoice_id,
            sum(pa.amount)::numeric(12,2) AS amount
           FROM payment_allocations pa
             JOIN payments p ON p.id = pa.payment_id
          WHERE p.status IS DISTINCT FROM 'voided'::text
          GROUP BY pa.invoice_id
        ), invoice_credited AS (
         SELECT cna.invoice_id,
            sum(cna.amount)::numeric(12,2) AS amount
           FROM credit_note_applications cna
             JOIN credit_notes cn ON cn.id = cna.credit_note_id
          WHERE cn.status::text <> ALL (ARRAY['draft'::text, 'cancelled'::text, 'voided'::text, 'void'::text])
          GROUP BY cna.invoice_id
        ), invoice_settled AS (
         SELECT inv.id AS invoice_id,
            (COALESCE(ip.amount, 0::numeric) + COALESCE(ic.amount, 0::numeric))::numeric(12,2) AS amount
           FROM invoices inv
             LEFT JOIN invoice_paid ip ON ip.invoice_id = inv.id
             LEFT JOIN invoice_credited ic ON ic.invoice_id = inv.id
        ), invoice_has_je AS (
         SELECT DISTINCT s.source_id AS invoice_id
           FROM ar_subledger_entries s
          WHERE s.source_type = 'invoice'::text AND s.source_id IS NOT NULL
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
            COALESCE(isx.amount, 0::numeric)::numeric(12,2) AS applied_amount,
            GREATEST(inv.total - COALESCE(isx.amount, 0::numeric), 0::numeric)::numeric(12,2) AS residual_amount,
            inv.status::text AS document_status,
            inv.journal_entry_id,
            COALESCE(NULLIF(inv.currency, ''::text), biz.base_currency) AS currency,
            (CASE
               WHEN COALESCE(NULLIF(inv.currency, ''::text), biz.base_currency) IS NOT DISTINCT FROM biz.base_currency
                 THEN 1::numeric
               ELSE NULLIF(inv.exchange_rate, 0::numeric)
             END)::numeric(18,8) AS exchange_rate,
            (GREATEST(inv.total - COALESCE(isx.amount, 0::numeric), 0::numeric) *
             (CASE
                WHEN COALESCE(NULLIF(inv.currency, ''::text), biz.base_currency) IS NOT DISTINCT FROM biz.base_currency
                  THEN 1::numeric
                ELSE NULLIF(inv.exchange_rate, 0::numeric)
              END))::numeric(14,2) AS base_residual_amount
           FROM invoices inv
             JOIN invoice_has_je ihj ON ihj.invoice_id = inv.id
             LEFT JOIN invoice_settled isx ON isx.invoice_id = inv.id
             LEFT JOIN businesses biz ON biz.id = inv.business_id
          WHERE (inv.status::text <> ALL (ARRAY['draft'::text, 'cancelled'::text, 'voided'::text, 'paid'::text]))
            AND (inv.total - COALESCE(isx.amount, 0::numeric)) > 0.01
        ), manual_je_rows AS (
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
            max(biz.base_currency) AS currency,
            1::numeric(18,8) AS exchange_rate,
            sum(s.debit - s.credit)::numeric(14,2) AS base_residual_amount
           FROM ar_subledger_entries s
             LEFT JOIN businesses biz ON biz.id = s.business_id
          WHERE s.contact_id IS NOT NULL
            AND (s.source_type IS NULL OR (s.source_type <> ALL (ARRAY['invoice'::text, 'payment'::text, 'customer_payment'::text, 'credit_note'::text, 'customer_refund'::text, 'refund'::text])))
          GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
         HAVING sum(s.debit - s.credit) > 0.01
        )
 SELECT invoice_rows.organization_id,
    invoice_rows.business_id,
    invoice_rows.branch_id,
    invoice_rows.document_id,
    invoice_rows.document_number,
    invoice_rows.contact_id,
    invoice_rows.document_date,
    invoice_rows.due_date,
    invoice_rows.document_total,
    invoice_rows.applied_amount,
    invoice_rows.residual_amount,
    invoice_rows.document_status,
    invoice_rows.journal_entry_id,
    invoice_rows.currency,
    invoice_rows.exchange_rate,
    invoice_rows.base_residual_amount
   FROM invoice_rows
UNION ALL
 SELECT manual_je_rows.organization_id,
    manual_je_rows.business_id,
    manual_je_rows.branch_id,
    manual_je_rows.document_id,
    manual_je_rows.document_number,
    manual_je_rows.contact_id,
    manual_je_rows.document_date,
    manual_je_rows.due_date,
    manual_je_rows.document_total,
    manual_je_rows.applied_amount,
    manual_je_rows.residual_amount,
    manual_je_rows.document_status,
    manual_je_rows.journal_entry_id,
    manual_je_rows.currency,
    manual_je_rows.exchange_rate,
    manual_je_rows.base_residual_amount
   FROM manual_je_rows;