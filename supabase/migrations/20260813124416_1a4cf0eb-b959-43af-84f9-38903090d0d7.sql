CREATE OR REPLACE FUNCTION public.finance_ap_open_items_as_of(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(organization_id uuid, business_id uuid, branch_id uuid, document_id uuid, document_number text, contact_id uuid, document_date date, due_date date, document_total numeric, paid_amount numeric, credited_amount numeric, residual_amount numeric, document_status text, journal_entry_id uuid, currency text, exchange_rate numeric, base_residual_amount numeric, source_kind text, aging_bucket text, days_past_due integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bill_je AS (
    SELECT s.source_id AS bill_id,
           MIN(s.entry_date) AS posted_on,
           MIN(s.journal_entry_id::text)::uuid AS journal_entry_id
      FROM public.ap_subledger_entries s
     WHERE s.source_type = 'bill'
       AND s.source_id IS NOT NULL
       AND s.entry_date <= _as_of
     GROUP BY s.source_id
  ),
  paid AS (
    SELECT bpa.bill_id, SUM(bpa.amount)::numeric AS amount
      FROM public.bill_payment_allocations bpa
      JOIN public.bill_payments bp ON bp.id = bpa.bill_payment_id
     WHERE bp.payment_date <= _as_of
       AND COALESCE(bp.status, 'posted') NOT IN ('draft','void','voided','cancelled','rejected')
       AND (bp.voided_at IS NULL OR bp.voided_at::date > _as_of)
     GROUP BY bpa.bill_id
  ),
  credited AS (
    SELECT vca.bill_id, SUM(vca.amount)::numeric AS amount
      FROM public.vendor_credit_note_applications vca
      JOIN public.vendor_credit_notes vcn ON vcn.id = vca.credit_note_id
     WHERE vcn.status NOT IN ('draft','cancelled','voided','void')
       AND COALESCE(vca.applied_at::date, vcn.credit_date) <= _as_of
       AND (vca.reversed_at IS NULL OR vca.reversed_at::date > _as_of)
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
      -- FX honesty (ADR 0135/0136): the document rate snapshot wins. With no
      -- snapshot, a same-currency document is 1 by definition; otherwise ask the
      -- single rate authority. If it cannot answer, the rate stays NULL and the
      -- base-currency projection is NULL — never a fabricated 1:1.
      CASE
        WHEN COALESCE(NULLIF(b.currency_rate, 0), 0) <> 0 THEN b.currency_rate::numeric
        WHEN COALESCE(NULLIF(b.currency, ''), biz.base_currency, 'USD')
             = COALESCE(biz.base_currency, 'USD') THEN 1::numeric
        ELSE public.resolve_exchange_rate(
               b.organization_id, b.business_id,
               COALESCE(NULLIF(b.currency, ''), biz.base_currency, 'USD'),
               _as_of)
      END AS exchange_rate,
      'bill'::text AS source_kind
    FROM public.bills b
    JOIN bill_je j        ON j.bill_id = b.id
    LEFT JOIN paid p      ON p.bill_id = b.id
    LEFT JOIN credited cr ON cr.bill_id = b.id
    LEFT JOIN public.businesses biz ON biz.id = b.business_id
    WHERE b.status::text NOT IN ('draft','void','voided','cancelled')
  ),
  -- Manual AP journals: obligations posted straight to the AP control account.
  -- Both directions are collected; net > 0 is an obligation, net < 0 is a
  -- settlement/adjustment with no document to attach to.
  manual_groups AS (
    SELECT
      s.organization_id,
      s.business_id,
      s.branch_id,
      s.journal_entry_id AS document_id,
      MAX(s.entry_number) AS document_number,
      s.contact_id,
      MIN(s.entry_date) AS document_date,
      SUM(s.credit - s.debit)::numeric AS net,
      COALESCE(MAX(biz.base_currency), 'USD') AS currency
    FROM public.ap_subledger_entries s
    LEFT JOIN public.businesses biz ON biz.id = s.business_id
    WHERE s.contact_id IS NOT NULL
      AND s.entry_date <= _as_of
      AND (s.source_type IS NULL OR s.source_type NOT IN ('bill','bill_payment','vendor_credit_note','vendor_refund'))
    GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  ),
  manual_settlements AS (
    -- Every column is qualified: bare names would collide with this function's
    -- OUT parameters (organization_id, business_id, ...) and abort the query.
    SELECT mg.organization_id AS organization_id,
           mg.business_id     AS business_id,
           mg.branch_id       AS branch_id,
           mg.contact_id      AS contact_id,
           SUM(-mg.net)::numeric AS credit_pool
      FROM manual_groups mg
     WHERE mg.net < -0.01
     GROUP BY mg.organization_id, mg.business_id, mg.branch_id, mg.contact_id
  ),
  manual_open AS (
    SELECT g.*,
           COALESCE(st.credit_pool, 0)::numeric AS credit_pool,
           SUM(g.net) OVER (
             PARTITION BY g.organization_id, g.business_id, g.branch_id, g.contact_id
             ORDER BY g.document_date, g.document_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )::numeric AS cumulative
      FROM manual_groups g
      LEFT JOIN manual_settlements st
        ON st.organization_id = g.organization_id
       AND st.business_id     = g.business_id
       AND st.branch_id IS NOT DISTINCT FROM g.branch_id
       AND st.contact_id      = g.contact_id
     WHERE g.net > 0.01
  ),
  manual_rows AS (
    -- Oldest-first (FIFO) application of the settlement pool.
    SELECT
      m.organization_id,
      m.business_id,
      m.branch_id,
      m.document_id,
      m.document_number,
      m.contact_id,
      m.document_date,
      m.document_date AS due_date,
      m.net AS document_total,
      LEAST(m.net, GREATEST(m.credit_pool - (m.cumulative - m.net), 0))::numeric AS paid_amount,
      0::numeric AS credited_amount,
      (m.net - LEAST(m.net, GREATEST(m.credit_pool - (m.cumulative - m.net), 0)))::numeric AS residual_amount,
      'journal'::text AS document_status,
      m.document_id AS journal_entry_id,
      m.currency,
      1::numeric AS exchange_rate,
      'journal'::text AS source_kind
    FROM manual_open m
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
    u.document_total::numeric(14,2),
    u.paid_amount::numeric(14,2),
    u.credited_amount::numeric(14,2),
    u.residual_amount::numeric(14,2),
    u.document_status,
    u.journal_entry_id,
    u.currency,
    u.exchange_rate::numeric(18,8),
    (u.residual_amount * u.exchange_rate)::numeric(14,2) AS base_residual_amount,
    u.source_kind,
    public.finance_aging_bucket(u.due_date, _as_of) AS aging_bucket,
    GREATEST(0, (_as_of - u.due_date))::int AS days_past_due
  FROM unioned u
  WHERE u.organization_id = _org_id
    AND (_business_id IS NULL OR u.business_id = _business_id)
    AND (_branch_id IS NULL OR u.branch_id = _branch_id)
    AND u.residual_amount > 0.01
  ORDER BY u.due_date, u.document_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_ap_open_items_as_of(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_ap_open_items_as_of(uuid, uuid, uuid, date) TO authenticated, service_role;