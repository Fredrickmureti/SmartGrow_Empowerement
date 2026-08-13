CREATE OR REPLACE VIEW public.finance_open_items_tieout AS
WITH ar_proj AS (
  SELECT o.organization_id, o.business_id,
         sum(o.base_residual_amount)::numeric(14,2) AS projection_residual
    FROM public.finance_ar_open_items o
   GROUP BY o.organization_id, o.business_id
), ar_ledger AS (
  SELECT s.organization_id, s.business_id,
         sum(s.debit - s.credit)::numeric(14,2) AS ledger_net
    FROM public.ar_subledger_entries s
   GROUP BY s.organization_id, s.business_id
), ap_bill_je AS (
  SELECT s.source_id AS bill_id, min(s.journal_entry_id::text)::uuid AS journal_entry_id
    FROM public.ap_subledger_entries s
   WHERE s.source_type = 'bill' AND s.source_id IS NOT NULL AND s.entry_date <= CURRENT_DATE
   GROUP BY s.source_id
), ap_paid AS (
  SELECT bpa.bill_id, sum(bpa.amount) AS amount
    FROM public.bill_payment_allocations bpa
    JOIN public.bill_payments bp ON bp.id = bpa.bill_payment_id
   WHERE bp.payment_date <= CURRENT_DATE
     AND COALESCE(bp.status, 'posted') <> ALL (ARRAY['draft','void','voided','cancelled','rejected'])
     AND (bp.voided_at IS NULL OR bp.voided_at::date > CURRENT_DATE)
   GROUP BY bpa.bill_id
), ap_credited AS (
  SELECT vca.bill_id, sum(vca.amount) AS amount
    FROM public.vendor_credit_note_applications vca
    JOIN public.vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
   WHERE vcn.status <> ALL (ARRAY['draft','cancelled','voided','void'])
     AND COALESCE(vca.applied_at::date, vcn.credit_date) <= CURRENT_DATE
     AND (vca.reversed_at IS NULL OR vca.reversed_at::date > CURRENT_DATE)
   GROUP BY vca.bill_id
), ap_bill_rows AS (
  SELECT b.organization_id,
         b.business_id,
         GREATEST(b.total - COALESCE(p.amount, 0) - COALESCE(cr.amount, 0), 0)
           * CASE
               WHEN NULLIF(b.currency_rate, 0) IS NOT NULL THEN b.currency_rate
               WHEN COALESCE(NULLIF(b.currency, ''), biz.base_currency, 'USD')
                    = COALESCE(biz.base_currency, 'USD') THEN 1
               ELSE NULL
             END AS base_residual_amount
    FROM public.bills b
    JOIN ap_bill_je j ON j.bill_id = b.id
    LEFT JOIN ap_paid p ON p.bill_id = b.id
    LEFT JOIN ap_credited cr ON cr.bill_id = b.id
    LEFT JOIN public.businesses biz ON biz.id = b.business_id
   WHERE b.status::text <> ALL (ARRAY['draft','void','voided','cancelled'])
), ap_manual_rows AS (
  SELECT s.organization_id,
         s.business_id,
         sum(s.credit - s.debit) AS base_residual_amount
    FROM public.ap_subledger_entries s
   WHERE s.contact_id IS NOT NULL
     AND s.entry_date <= CURRENT_DATE
     AND (s.source_type IS NULL
          OR s.source_type <> ALL (ARRAY['bill','bill_payment','vendor_credit_note','vendor_refund']))
   GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING sum(s.credit - s.debit) > 0.01
), ap_proj AS (
  SELECT organization_id, business_id,
         sum(base_residual_amount)::numeric(14,2) AS projection_residual
    FROM (
      SELECT organization_id, business_id, base_residual_amount FROM ap_bill_rows
      UNION ALL
      SELECT organization_id, business_id, base_residual_amount FROM ap_manual_rows
    ) u
   GROUP BY organization_id, business_id
), ap_ledger AS (
  SELECT s.organization_id, s.business_id,
         sum(s.credit - s.debit)::numeric(14,2) AS ledger_net
    FROM public.ap_subledger_entries s
   GROUP BY s.organization_id, s.business_id
)
SELECT 'ar'::text AS side,
       COALESCE(p.organization_id, l.organization_id) AS organization_id,
       COALESCE(p.business_id, l.business_id) AS business_id,
       COALESCE(p.projection_residual, 0)::numeric(14,2) AS projection_residual,
       COALESCE(l.ledger_net, 0)::numeric(14,2) AS ledger_net,
       (COALESCE(p.projection_residual, 0) - COALESCE(l.ledger_net, 0))::numeric(14,2) AS drift
  FROM ar_proj p
  FULL JOIN ar_ledger l
    ON l.organization_id = p.organization_id
   AND NOT l.business_id IS DISTINCT FROM p.business_id
UNION ALL
SELECT 'ap'::text AS side,
       COALESCE(p.organization_id, l.organization_id) AS organization_id,
       COALESCE(p.business_id, l.business_id) AS business_id,
       COALESCE(p.projection_residual, 0)::numeric(14,2) AS projection_residual,
       COALESCE(l.ledger_net, 0)::numeric(14,2) AS ledger_net,
       (COALESCE(p.projection_residual, 0) - COALESCE(l.ledger_net, 0))::numeric(14,2) AS drift
  FROM ap_proj p
  FULL JOIN ap_ledger l
    ON l.organization_id = p.organization_id
   AND NOT l.business_id IS DISTINCT FROM p.business_id;

DROP VIEW IF EXISTS public.finance_ap_open_items;

COMMENT ON VIEW public.finance_open_items_tieout IS
  'Drift sensor: AR/AP open-item projection vs subledger net. The AP side is computed inline (bills + manual accruals) since the legacy finance_ap_open_items view was retired in favour of finance_ap_open_items_as_of.';