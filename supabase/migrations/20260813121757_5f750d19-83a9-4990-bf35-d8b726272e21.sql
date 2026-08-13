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
    SELECT organization_id, business_id, branch_id, contact_id,
           SUM(-net)::numeric AS credit_pool
      FROM manual_groups
     WHERE net < -0.01
     GROUP BY organization_id, business_id, branch_id, contact_id
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
    AND u.residual_amount > 0.01;
END;
$function$;

-- 7c: authorization parity for the shared AR/AP aging report.
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
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) TO service_role;