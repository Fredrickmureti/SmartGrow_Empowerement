-- finance_ar_net_position: attribute unapplied customer credit ONCE.
--
-- Defect: `agg` is grained by (org, business, branch, contact) while `credit`
-- was grained by (org, business, contact). The LEFT JOIN therefore repeated
-- the customer's full credit balance on every branch row, so any roll-up over
-- branches (customer ledger directory, top-exposure cards, collections work
-- lists) over-credited by (branch_count - 1) x credit.
--
-- Fix: rank the customer's branch rows deterministically and attach the credit
-- to exactly one of them (the branch with the largest open amount, tie-broken
-- by branch_id). Column shape is preserved so every existing caller keeps
-- working; branch-level `net_amount` for the non-carrying branches now equals
-- `open_amount`, and the sum across branches equals open - credit exactly once.
CREATE OR REPLACE VIEW public.finance_ar_net_position
WITH (security_invoker = on) AS
  WITH items AS (
    SELECT
      o.organization_id, o.business_id, o.branch_id, o.contact_id,
      o.base_residual_amount AS amt,
      public.finance_aging_bucket(o.due_date, CURRENT_DATE) AS bucket,
      GREATEST(0, (CURRENT_DATE - COALESCE(o.due_date, o.document_date))::int) AS days_overdue
    FROM public.finance_ar_open_items o
    WHERE o.residual_amount > 0.01
      AND o.document_date <= CURRENT_DATE
  ),
  agg AS (
    SELECT
      organization_id, business_id, branch_id, contact_id,
      COUNT(*)::int                                                   AS open_document_count,
      COALESCE(SUM(amt), 0)::numeric(14,2)                            AS open_amount,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'not_due'), 0)::numeric(14,2) AS not_due,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'current'), 0)::numeric(14,2) AS current_bucket,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days30'),  0)::numeric(14,2) AS days30,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days60'),  0)::numeric(14,2) AS days60,
      COALESCE(SUM(amt) FILTER (WHERE bucket = 'days90'),  0)::numeric(14,2) AS days90,
      COALESCE(MAX(days_overdue), 0)                                  AS max_days_overdue
    FROM items
    GROUP BY organization_id, business_id, branch_id, contact_id
  ),
  ranked AS (
    SELECT
      a.*,
      ROW_NUMBER() OVER (
        PARTITION BY a.organization_id, a.business_id, a.contact_id
        ORDER BY a.open_amount DESC, a.branch_id NULLS LAST
      ) AS credit_carrier_rank
    FROM agg a
  ),
  credit AS (
    SELECT organization_id, business_id, contact_id,
           COALESCE(SUM(base_credit_amount), 0)::numeric(14,2) AS credit_amount
    FROM public.finance_ar_customer_credit
    GROUP BY organization_id, business_id, contact_id
  )
  SELECT
    a.organization_id, a.business_id, a.branch_id, a.contact_id,
    c.name AS contact_name,
    a.open_document_count,
    a.open_amount,
    -- Credit lands on the carrier row only, so branch rows sum correctly.
    CASE WHEN a.credit_carrier_rank = 1
         THEN COALESCE(cr.credit_amount, 0)
         ELSE 0 END::numeric(14,2)                             AS credit_amount,
    (a.open_amount - CASE WHEN a.credit_carrier_rank = 1
                          THEN COALESCE(cr.credit_amount, 0)
                          ELSE 0 END)::numeric(14,2)           AS net_amount,
    a.not_due, a.current_bucket, a.days30, a.days60, a.days90,
    a.max_days_overdue
  FROM ranked a
  LEFT JOIN credit cr
         ON cr.organization_id = a.organization_id
        AND cr.contact_id      = a.contact_id
        AND cr.business_id IS NOT DISTINCT FROM a.business_id
  LEFT JOIN public.contacts c ON c.id = a.contact_id
  -- finance_ar_open_items is owner-run, so scope this projection explicitly.
  WHERE public.is_org_member(auth.uid(), a.organization_id);

GRANT SELECT ON public.finance_ar_net_position TO authenticated;
GRANT ALL    ON public.finance_ar_net_position TO service_role;

COMMENT ON VIEW public.finance_ar_net_position IS
  'Per-counterparty net receivable position as of today: base-currency open amount bucketed by age, less unapplied credit. Credit is attached to a single branch row per (org, business, contact) so branch roll-ups never double-count it. Read-side surfaces (top exposures, collections work lists) MUST read this instead of bucketing/netting in application code.';