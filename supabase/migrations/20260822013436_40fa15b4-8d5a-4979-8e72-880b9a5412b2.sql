-- ADR 0136 Phase 16: finance_open_items_tieout must not assume a currency and
-- must declare absence instead of summing around an unconvertible document.
CREATE OR REPLACE VIEW public.finance_open_items_tieout AS
WITH ar_rows AS (
  SELECT o.organization_id, o.business_id, o.base_residual_amount
    FROM public.finance_ar_open_items o
), ar_proj AS (
  SELECT r.organization_id, r.business_id,
         (CASE WHEN COUNT(*) FILTER (WHERE r.base_residual_amount IS NULL) > 0
               THEN NULL ELSE SUM(r.base_residual_amount) END)::numeric(14,2) AS projection_residual,
         COUNT(*) FILTER (WHERE r.base_residual_amount IS NULL)::int AS unconvertible_document_count
    FROM ar_rows r
   GROUP BY r.organization_id, r.business_id
), ar_ledger AS (
  SELECT s.organization_id, s.business_id,
         SUM(s.debit - s.credit)::numeric(14,2) AS ledger_net
    FROM public.ar_subledger_entries s
   GROUP BY s.organization_id, s.business_id
), ap_bill_je AS (
  SELECT s.source_id AS bill_id, MIN(s.journal_entry_id::text)::uuid AS journal_entry_id
    FROM public.ap_subledger_entries s
   WHERE s.source_type = 'bill' AND s.source_id IS NOT NULL AND s.entry_date <= CURRENT_DATE
   GROUP BY s.source_id
), ap_paid AS (
  SELECT bpa.bill_id, SUM(bpa.amount) AS amount
    FROM public.bill_payment_allocations bpa
    JOIN public.bill_payments bp ON bp.id = bpa.bill_payment_id
   WHERE bp.payment_date <= CURRENT_DATE
     AND COALESCE(bp.status, 'posted') <> ALL (ARRAY['draft','void','voided','cancelled','rejected'])
     AND (bp.voided_at IS NULL OR bp.voided_at::date > CURRENT_DATE)
   GROUP BY bpa.bill_id
), ap_credited AS (
  SELECT vca.bill_id, SUM(vca.amount) AS amount
    FROM public.vendor_credit_note_applications vca
    JOIN public.vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
   WHERE vcn.status <> ALL (ARRAY['draft','cancelled','voided','void'])
     AND COALESCE(vca.applied_at::date, vcn.credit_date) <= CURRENT_DATE
     AND (vca.reversed_at IS NULL OR vca.reversed_at::date > CURRENT_DATE)
   GROUP BY vca.bill_id
), ap_bill_rows AS (
  -- ADR 0136: the stamped rate governs when present; otherwise the canonical
  -- resolver answers. No currency literal, no 1:1 assumption. A bill with no
  -- resolvable rate contributes NULL — an honest absence.
  SELECT b.organization_id, b.business_id,
         CASE
           WHEN NULLIF(b.currency_rate, 0) IS NOT NULL
             THEN GREATEST(b.total - COALESCE(p.amount,0) - COALESCE(cr.amount,0), 0) * b.currency_rate
           WHEN COALESCE(NULLIF(b.currency,''), biz.base_currency) IS NULL THEN NULL
           ELSE public.to_base_amount(
                  b.business_id,
                  COALESCE(NULLIF(b.currency,''), biz.base_currency),
                  GREATEST(b.total - COALESCE(p.amount,0) - COALESCE(cr.amount,0), 0),
                  CURRENT_DATE)
         END AS base_residual_amount
    FROM public.bills b
    JOIN ap_bill_je j ON j.bill_id = b.id
    LEFT JOIN ap_paid p ON p.bill_id = b.id
    LEFT JOIN ap_credited cr ON cr.bill_id = b.id
    LEFT JOIN public.businesses biz ON biz.id = b.business_id
   WHERE b.status::text <> ALL (ARRAY['draft','void','voided','cancelled'])
), ap_manual_rows AS (
  SELECT s.organization_id, s.business_id,
         SUM(s.credit - s.debit) AS base_residual_amount
    FROM public.ap_subledger_entries s
   WHERE s.contact_id IS NOT NULL AND s.entry_date <= CURRENT_DATE
     AND (s.source_type IS NULL OR s.source_type <> ALL (ARRAY['bill','bill_payment','vendor_credit_note','vendor_refund']))
   GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING SUM(s.credit - s.debit) > 0.01
), ap_proj AS (
  SELECT u.organization_id, u.business_id,
         (CASE WHEN COUNT(*) FILTER (WHERE u.base_residual_amount IS NULL) > 0
               THEN NULL ELSE SUM(u.base_residual_amount) END)::numeric(14,2) AS projection_residual,
         COUNT(*) FILTER (WHERE u.base_residual_amount IS NULL)::int AS unconvertible_document_count
    FROM (
      SELECT organization_id, business_id, base_residual_amount FROM ap_bill_rows
      UNION ALL
      SELECT organization_id, business_id, base_residual_amount FROM ap_manual_rows
    ) u
   GROUP BY u.organization_id, u.business_id
), ap_ledger AS (
  SELECT s.organization_id, s.business_id,
         SUM(s.credit - s.debit)::numeric(14,2) AS ledger_net
    FROM public.ap_subledger_entries s
   GROUP BY s.organization_id, s.business_id
)
SELECT 'ar'::text AS side,
       COALESCE(p.organization_id, l.organization_id) AS organization_id,
       COALESCE(p.business_id, l.business_id) AS business_id,
       p.projection_residual::numeric(14,2) AS projection_residual,
       COALESCE(l.ledger_net, 0)::numeric(14,2) AS ledger_net,
       (p.projection_residual - COALESCE(l.ledger_net, 0))::numeric(14,2) AS drift,
       COALESCE(p.unconvertible_document_count, 0) AS unconvertible_document_count
  FROM ar_proj p
  FULL JOIN ar_ledger l
    ON l.organization_id = p.organization_id
   AND NOT l.business_id IS DISTINCT FROM p.business_id
UNION ALL
SELECT 'ap'::text AS side,
       COALESCE(p.organization_id, l.organization_id) AS organization_id,
       COALESCE(p.business_id, l.business_id) AS business_id,
       p.projection_residual::numeric(14,2) AS projection_residual,
       COALESCE(l.ledger_net, 0)::numeric(14,2) AS ledger_net,
       (p.projection_residual - COALESCE(l.ledger_net, 0))::numeric(14,2) AS drift,
       COALESCE(p.unconvertible_document_count, 0) AS unconvertible_document_count
  FROM ap_proj p
  FULL JOIN ap_ledger l
    ON l.organization_id = p.organization_id
   AND NOT l.business_id IS DISTINCT FROM p.business_id;