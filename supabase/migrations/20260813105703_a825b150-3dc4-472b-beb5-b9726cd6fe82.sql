-- Phase 5.4 — retire the legacy "current position" AP projection.
--
-- `finance_ap_open_items` is kept ONLY as a deprecated compatibility surface
-- for the drift monitor and legacy SQL contract tests. Its body is the
-- `finance_ap_open_items_as_of` engine evaluated at CURRENT_DATE with the
-- org/business/branch predicate lifted out, so there is exactly one AP
-- residual definition in the product. New callers must use the RPC.

DROP VIEW IF EXISTS public.finance_open_items_tieout;
DROP VIEW IF EXISTS public.finance_ap_open_items;

CREATE VIEW public.finance_ap_open_items
WITH (security_invoker = true) AS
WITH bill_je AS (
  SELECT s.source_id AS bill_id,
         MIN(s.journal_entry_id::text)::uuid AS journal_entry_id
    FROM public.ap_subledger_entries s
   WHERE s.source_type = 'bill'
     AND s.source_id IS NOT NULL
     AND s.entry_date <= CURRENT_DATE
   GROUP BY s.source_id
),
paid AS (
  SELECT bpa.bill_id, SUM(bpa.amount)::numeric AS amount
    FROM public.bill_payment_allocations bpa
    JOIN public.bill_payments bp ON bp.id = bpa.bill_payment_id
   WHERE bp.payment_date <= CURRENT_DATE
     AND COALESCE(bp.status, 'posted') NOT IN ('draft','void','voided','cancelled','rejected')
     AND (bp.voided_at IS NULL OR bp.voided_at::date > CURRENT_DATE)
   GROUP BY bpa.bill_id
),
credited AS (
  SELECT vca.bill_id, SUM(vca.amount)::numeric AS amount
    FROM public.vendor_credit_note_applications vca
    JOIN public.vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
   WHERE vcn.status NOT IN ('draft','cancelled','voided','void')
     AND COALESCE(vca.applied_at::date, vcn.credit_date) <= CURRENT_DATE
     AND (vca.reversed_at IS NULL OR vca.reversed_at::date > CURRENT_DATE)
   GROUP BY vca.bill_id
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
    COALESCE(b.due_date, b.bill_date) AS due_date,
    b.total::numeric AS document_total,
    COALESCE(p.amount, 0)::numeric AS paid_amount,
    COALESCE(cr.amount, 0)::numeric AS credited_amount,
    GREATEST(b.total - COALESCE(p.amount,0) - COALESCE(cr.amount,0), 0)::numeric AS residual_amount,
    b.status::text AS document_status,
    j.journal_entry_id,
    COALESCE(NULLIF(b.currency, ''), biz.base_currency, 'USD') AS currency,
    COALESCE(NULLIF(b.currency_rate, 0), 1)::numeric AS exchange_rate,
    'bill'::text AS source_kind
  FROM public.bills b
  JOIN bill_je j        ON j.bill_id = b.id
  LEFT JOIN paid p      ON p.bill_id = b.id
  LEFT JOIN credited cr ON cr.bill_id = b.id
  LEFT JOIN public.businesses biz ON biz.id = b.business_id
  WHERE b.status::text NOT IN ('draft','void','voided','cancelled')
),
manual_rows AS (
  SELECT
    s.organization_id,
    s.business_id,
    s.branch_id,
    s.journal_entry_id AS document_id,
    MAX(s.entry_number) AS document_number,
    s.contact_id,
    MIN(s.entry_date) AS document_date,
    MIN(s.entry_date) AS due_date,
    SUM(s.credit - s.debit)::numeric AS document_total,
    0::numeric AS paid_amount,
    0::numeric AS credited_amount,
    SUM(s.credit - s.debit)::numeric AS residual_amount,
    'journal'::text AS document_status,
    s.journal_entry_id,
    COALESCE(MAX(biz.base_currency), 'USD') AS currency,
    1::numeric AS exchange_rate,
    'journal'::text AS source_kind
  FROM public.ap_subledger_entries s
  LEFT JOIN public.businesses biz ON biz.id = s.business_id
  WHERE s.contact_id IS NOT NULL
    AND s.entry_date <= CURRENT_DATE
    AND (s.source_type IS NULL OR s.source_type NOT IN ('bill','bill_payment','vendor_credit_note','vendor_refund'))
  GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  HAVING SUM(s.credit - s.debit) > 0.01
),
unioned AS (
  SELECT * FROM bill_rows
  UNION ALL
  SELECT * FROM manual_rows
)
SELECT
  u.organization_id,
  u.business_id,
  u.branch_id,
  u.document_id,
  u.document_number,
  u.contact_id,
  u.document_date,
  u.due_date,
  u.document_total::numeric(14,2) AS document_total,
  u.paid_amount::numeric(14,2) AS paid_amount,
  u.credited_amount::numeric(14,2) AS credited_amount,
  u.residual_amount::numeric(14,2) AS residual_amount,
  u.document_status,
  u.journal_entry_id,
  u.currency,
  u.exchange_rate::numeric(18,8) AS exchange_rate,
  (u.residual_amount * u.exchange_rate)::numeric(14,2) AS base_residual_amount,
  u.source_kind,
  public.finance_aging_bucket(u.due_date, CURRENT_DATE) AS aging_bucket,
  GREATEST(0, (CURRENT_DATE - u.due_date))::int AS days_past_due
FROM unioned u
WHERE u.residual_amount > 0.01;

COMMENT ON VIEW public.finance_ap_open_items IS
  'DEPRECATED compatibility surface. Mirrors finance_ap_open_items_as_of(org, business, branch, CURRENT_DATE) with the scope predicate lifted out. New code MUST call the RPC so it can answer for a historical date; this view can only ever answer "today".';

GRANT SELECT ON public.finance_ap_open_items TO authenticated, service_role;

-- Drift monitor rebuilt: the AP side now projects through the single engine.
CREATE VIEW public.finance_open_items_tieout
WITH (security_invoker = true) AS
WITH ar_proj AS (
  SELECT o.organization_id, o.business_id,
         SUM(o.base_residual_amount)::numeric(14,2) AS projection_residual
    FROM public.finance_ar_open_items o
   GROUP BY o.organization_id, o.business_id
), ar_ledger AS (
  SELECT s.organization_id, s.business_id,
         SUM(s.debit - s.credit)::numeric(14,2) AS ledger_net
    FROM public.ar_subledger_entries s
   GROUP BY s.organization_id, s.business_id
), ap_proj AS (
  SELECT o.organization_id, o.business_id,
         SUM(o.base_residual_amount)::numeric(14,2) AS projection_residual
    FROM public.finance_ap_open_items o
   GROUP BY o.organization_id, o.business_id
), ap_ledger AS (
  SELECT s.organization_id, s.business_id,
         SUM(s.credit - s.debit)::numeric(14,2) AS ledger_net
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

COMMENT ON VIEW public.finance_open_items_tieout IS
  'Drift sensor: open-items projection vs subledger net, per organisation/business. AP side is the single point-in-time engine evaluated at CURRENT_DATE.';

GRANT SELECT ON public.finance_open_items_tieout TO authenticated, service_role;