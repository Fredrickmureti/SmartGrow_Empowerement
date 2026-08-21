-- ADR 0136 Phase 12 — absence parity on the payables side.
-- Row-level projections were already rate-honest (NULL base amount when no rate
-- is on file); the aggregates destroyed that absence with COALESCE(SUM(...),0),
-- which silently understates the payable. Absence now propagates and is counted.

-- 12b: no fabricated 'USD' denomination in the point-in-time engines.
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
      -- ADR 0136: denomination is the document's own currency, else the company
      -- base currency. A company with no base currency configured yields NULL —
      -- an unknown denomination, never an assumed one.
      COALESCE(NULLIF(b.currency, ''), biz.base_currency) AS currency,
      CASE
        WHEN COALESCE(NULLIF(b.currency_rate, 0), 0) <> 0 THEN b.currency_rate::numeric
        WHEN biz.base_currency IS NOT NULL
             AND COALESCE(NULLIF(b.currency, ''), biz.base_currency) = biz.base_currency THEN 1::numeric
        WHEN COALESCE(NULLIF(b.currency, ''), biz.base_currency) IS NULL THEN NULL::numeric
        ELSE public.resolve_exchange_rate(
               b.organization_id, b.business_id,
               COALESCE(NULLIF(b.currency, ''), biz.base_currency),
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
      MAX(biz.base_currency) AS currency
    FROM public.ap_subledger_entries s
    LEFT JOIN public.businesses biz ON biz.id = s.business_id
    WHERE s.contact_id IS NOT NULL
      AND s.entry_date <= _as_of
      AND (s.source_type IS NULL OR s.source_type NOT IN ('bill','bill_payment','vendor_credit_note','vendor_refund'))
    GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  ),
  manual_settlements AS (
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

CREATE OR REPLACE FUNCTION public.finance_ar_open_items_as_of(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
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
  WITH invoice_je AS (
    SELECT s.source_id AS invoice_id,
           MIN(s.entry_date) AS posted_on,
           MIN(s.journal_entry_id::text)::uuid AS journal_entry_id
      FROM public.ar_subledger_entries s
     WHERE s.source_type = 'invoice'
       AND s.source_id IS NOT NULL
       AND s.entry_date <= _as_of
     GROUP BY s.source_id
  ),
  paid AS (
    SELECT pa.invoice_id, SUM(pa.amount)::numeric AS amount
      FROM public.payment_allocations pa
      JOIN public.payments p ON p.id = pa.payment_id
     WHERE p.payment_date <= _as_of
       AND COALESCE(p.status, 'posted') NOT IN ('draft','void','voided','cancelled','rejected')
       AND (p.voided_at IS NULL OR p.voided_at::date > _as_of)
     GROUP BY pa.invoice_id
  ),
  credited AS (
    SELECT cna.invoice_id, SUM(cna.amount)::numeric AS amount
      FROM public.credit_note_applications cna
      JOIN public.credit_notes cn ON cn.id = cna.credit_note_id
     WHERE cn.status::text NOT IN ('draft','cancelled','voided','void')
       AND COALESCE(cna.applied_at::date, cn.issue_date) <= _as_of
     GROUP BY cna.invoice_id
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
      COALESCE(inv.due_date, inv.issue_date) AS due_date,
      inv.total::numeric AS document_total,
      COALESCE(p.amount, 0)::numeric AS paid_amount,
      COALESCE(cr.amount, 0)::numeric AS credited_amount,
      GREATEST(inv.total - COALESCE(p.amount,0) - COALESCE(cr.amount,0), 0)::numeric AS residual_amount,
      inv.status::text AS document_status,
      j.journal_entry_id,
      COALESCE(NULLIF(inv.currency, ''), biz.base_currency) AS currency,
      CASE
        WHEN COALESCE(NULLIF(inv.exchange_rate, 0), 0) <> 0 THEN inv.exchange_rate::numeric
        WHEN biz.base_currency IS NOT NULL
             AND COALESCE(NULLIF(inv.currency, ''), biz.base_currency) = biz.base_currency THEN 1::numeric
        WHEN COALESCE(NULLIF(inv.currency, ''), biz.base_currency) IS NULL THEN NULL::numeric
        ELSE public.resolve_exchange_rate(
               inv.organization_id, inv.business_id,
               COALESCE(NULLIF(inv.currency, ''), biz.base_currency),
               _as_of)
      END AS exchange_rate,
      'invoice'::text AS source_kind
    FROM public.invoices inv
    JOIN invoice_je j       ON j.invoice_id = inv.id
    LEFT JOIN paid p        ON p.invoice_id = inv.id
    LEFT JOIN credited cr   ON cr.invoice_id = inv.id
    LEFT JOIN public.businesses biz ON biz.id = inv.business_id
    WHERE inv.status::text NOT IN ('draft','void','voided','cancelled')
  ),
  manual_groups AS (
    SELECT
      s.organization_id,
      s.business_id,
      s.branch_id,
      s.journal_entry_id AS document_id,
      MAX(s.entry_number) AS document_number,
      s.contact_id,
      MIN(s.entry_date) AS document_date,
      SUM(s.debit - s.credit)::numeric AS net,
      MAX(biz.base_currency) AS currency
    FROM public.ar_subledger_entries s
    LEFT JOIN public.businesses biz ON biz.id = s.business_id
    WHERE s.contact_id IS NOT NULL
      AND s.entry_date <= _as_of
      AND (s.source_type IS NULL OR s.source_type NOT IN
           ('invoice','payment','customer_payment','credit_note','customer_refund','refund'))
    GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  ),
  manual_settlements AS (
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
    SELECT * FROM invoice_rows
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

CREATE OR REPLACE FUNCTION public.finance_ap_vendor_credit_as_of(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(organization_id uuid, business_id uuid, branch_id uuid, contact_id uuid, currency text, credit_amount numeric, base_credit_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH notes AS (
    SELECT vcn.id, vcn.organization_id, vcn.business_id, vcn.branch_id,
           vcn.vendor_id AS contact_id,
           -- ADR 0136: never assume a denomination.
           COALESCE(NULLIF(vcn.currency,''), biz.base_currency) AS currency,
           vcn.total::numeric AS total
      FROM public.vendor_credit_notes vcn
      LEFT JOIN public.businesses biz ON biz.id = vcn.business_id
     WHERE vcn.organization_id = _org_id
       AND (_business_id IS NULL OR vcn.business_id = _business_id)
       AND (_branch_id IS NULL OR vcn.branch_id = _branch_id)
       AND vcn.status NOT IN ('draft','cancelled','voided','void')
       AND vcn.credit_date <= _as_of
       AND (vcn.reversed_at IS NULL OR vcn.reversed_at::date > _as_of)
  ),
  applied AS (
    SELECT vca.credit_note_id, SUM(vca.amount)::numeric AS amount
      FROM public.vendor_credit_note_applications vca
      JOIN notes n ON n.id = vca.credit_note_id
     WHERE COALESCE(vca.applied_at::date, _as_of) <= _as_of
       AND (vca.reversed_at IS NULL OR vca.reversed_at::date > _as_of)
     GROUP BY vca.credit_note_id
  ),
  residual AS (
    SELECT n.organization_id, n.business_id, n.branch_id, n.contact_id, n.currency,
           (n.total - COALESCE(a.amount,0))::numeric AS open_amount,
           CASE WHEN n.currency IS NULL THEN NULL
                ELSE public.to_base_amount(n.business_id, n.currency, n.total - COALESCE(a.amount,0), _as_of)
           END AS base_amount
      FROM notes n
      LEFT JOIN applied a ON a.credit_note_id = n.id
  )
  SELECT r.organization_id, r.business_id, r.branch_id, r.contact_id, r.currency,
         SUM(r.open_amount)::numeric(14,2) AS credit_amount,
         (CASE WHEN COUNT(*) FILTER (WHERE r.base_amount IS NULL) > 0
               THEN NULL
               ELSE SUM(r.base_amount) END)::numeric(14,2) AS base_credit_amount
    FROM residual r
   GROUP BY r.organization_id, r.business_id, r.branch_id, r.contact_id, r.currency
  HAVING SUM(r.open_amount) > 0.01;
END;
$function$;

-- 12a: absence survives aggregation.

DROP FUNCTION IF EXISTS public.get_ap_summary(uuid, uuid, uuid, date);
CREATE FUNCTION public.get_ap_summary(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(open_document_count integer, total_residual numeric, not_due numeric, current_bucket numeric, days30 numeric, days60 numeric, days90 numeric, overdue_count integer, unposted_document_count integer, unposted_amount numeric, unconvertible_document_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH open_items AS (
    SELECT * FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of)
  ),
  credits AS (
    -- A credit with no rate on file is an absence, not a zero.
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(c.base_credit_amount), 0) END)::numeric AS amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(b.total,0) - COALESCE(b.amount_paid,0))), 0) AS amt
      FROM public.bills b
     WHERE b.organization_id = _org_id
       AND (_business_id IS NULL OR b.business_id = _business_id)
       AND (_branch_id IS NULL OR b.branch_id = _branch_id)
       AND b.status::text NOT IN ('draft','submitted','approved','cancelled','voided','void','paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'bill' AND je.source_id = b.id AND je.status = 'posted'
       )
  ),
  agg AS (
    SELECT
      COUNT(*)::int AS doc_count,
      COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL)::int AS unconvertible,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL) > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount), 0) END)::numeric AS total_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL AND oi.aging_bucket = 'not_due') > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount) FILTER (WHERE oi.aging_bucket = 'not_due'), 0) END)::numeric AS not_due_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL AND oi.aging_bucket = 'current') > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount) FILTER (WHERE oi.aging_bucket = 'current'), 0) END)::numeric AS current_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL AND oi.aging_bucket = 'days30') > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount) FILTER (WHERE oi.aging_bucket = 'days30'), 0) END)::numeric AS d30,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL AND oi.aging_bucket = 'days60') > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount) FILTER (WHERE oi.aging_bucket = 'days60'), 0) END)::numeric AS d60,
      (CASE WHEN COUNT(*) FILTER (WHERE oi.base_residual_amount IS NULL AND oi.aging_bucket = 'days90') > 0
            THEN NULL ELSE COALESCE(SUM(oi.base_residual_amount) FILTER (WHERE oi.aging_bucket = 'days90'), 0) END)::numeric AS d90,
      COUNT(*) FILTER (WHERE oi.days_past_due > 0)::int AS overdue
    FROM open_items oi
  )
  SELECT
    a.doc_count,
    a.total_amt - (SELECT amt FROM credits),
    a.not_due_amt,
    a.current_amt,
    a.d30,
    a.d60,
    a.d90,
    a.overdue,
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted),
    a.unconvertible
  FROM agg a;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_ap_summary(uuid, uuid, uuid, date) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_ar_summary(uuid, uuid, uuid, date);
CREATE FUNCTION public.get_ar_summary(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(open_document_count integer, total_residual numeric, not_due numeric, current_bucket numeric, days30 numeric, days60 numeric, days90 numeric, overdue_count integer, unposted_document_count integer, unposted_amount numeric, unconvertible_document_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH open_items AS (
    SELECT * FROM public.finance_ar_open_items_as_of(_org_id, _business_id, _branch_id, _as_of)
  ),
  credits AS (
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(c.base_credit_amount), 0) END)::numeric AS amt
      FROM public.finance_ar_customer_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(i.total,0) - COALESCE(i.amount_paid,0))), 0) AS amt
      FROM public.invoices i
     WHERE i.organization_id = _org_id
       AND (_business_id IS NULL OR i.business_id = _business_id)
       AND (_branch_id IS NULL OR i.branch_id = _branch_id)
       AND i.issue_date <= _as_of
       AND i.status NOT IN ('draft', 'cancelled', 'voided', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'invoice'
            AND je.source_id = i.id
            AND je.status = 'posted'
            AND je.entry_date <= _as_of
       )
  ),
  agg AS (
    SELECT
      COUNT(*)::int AS doc_count,
      COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL)::int AS unconvertible,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL) > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount), 0) END)::numeric AS total_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'not_due') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'not_due'), 0) END)::numeric AS not_due_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'current') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'current'), 0) END)::numeric AS current_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days30') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days30'), 0) END)::numeric AS d30,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days60') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days60'), 0) END)::numeric AS d60,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days90') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days90'), 0) END)::numeric AS d90,
      COUNT(*) FILTER (WHERE o.aging_bucket <> 'not_due')::int AS overdue
    FROM open_items o
  )
  SELECT
    a.doc_count,
    a.total_amt - (SELECT amt FROM credits),
    a.not_due_amt,
    a.current_amt - (SELECT amt FROM credits),
    a.d30,
    a.d60,
    a.d90,
    a.overdue,
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted),
    a.unconvertible
  FROM agg a;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.finance_ap_aging_reconciliation(uuid, uuid, uuid, date);
CREATE FUNCTION public.finance_ap_aging_reconciliation(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(aging_total numeric, control_account_balance numeric, variance numeric, in_balance boolean, unconvertible_document_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH aging AS (
    -- ADR 0136: a tie-out cannot be asserted over an incomplete population.
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(o.base_residual_amount), 0) END)::numeric AS amt,
           COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL)::int AS unconvertible
      FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of) o
  ),
  credits AS (
    SELECT (CASE WHEN COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(c.base_credit_amount), 0) END)::numeric AS amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
  ),
  control AS (
    SELECT COALESCE(SUM(s.credit - s.debit), 0)::numeric AS amt
      FROM public.ap_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id IS NULL OR s.branch_id = _branch_id)
       AND s.entry_date <= _as_of
  )
  SELECT
    ((SELECT amt FROM aging) - (SELECT amt FROM credits))::numeric(14,2),
    (SELECT amt FROM control)::numeric(14,2),
    (((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control))::numeric(14,2),
    COALESCE(
      ABS(((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control)) <= 0.01,
      false),
    (SELECT unconvertible FROM aging);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.finance_ap_aging_reconciliation(uuid, uuid, uuid, date) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date);
CREATE FUNCTION public.finance_ap_reconciliation_detail(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(contact_id uuid, contact_name text, projection_open numeric, projection_credit numeric, projection_net numeric, ledger_net numeric, variance numeric, reason text, document_count integer, unconvertible_document_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH proj AS (
    SELECT o.contact_id,
           (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(o.base_residual_amount), 0) END)::numeric AS open_amt,
           COUNT(*)::int AS doc_count,
           COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL)::int AS unconvertible
      FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of) o
     GROUP BY o.contact_id
  ),
  cred AS (
    SELECT c.contact_id,
           (CASE WHEN COUNT(*) FILTER (WHERE c.base_credit_amount IS NULL) > 0
                 THEN NULL ELSE COALESCE(SUM(c.base_credit_amount), 0) END)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
     GROUP BY c.contact_id
  ),
  ledger AS (
    SELECT s.contact_id,
           COALESCE(SUM(s.credit - s.debit), 0)::numeric AS net_amt
      FROM public.ap_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id IS NULL OR s.branch_id = _branch_id)
       AND s.entry_date <= _as_of
     GROUP BY s.contact_id
  ),
  keys AS (
    SELECT proj.contact_id FROM proj
    UNION
    SELECT cred.contact_id FROM cred
    UNION
    SELECT ledger.contact_id FROM ledger
  ),
  rows_out AS (
    SELECT
      k.contact_id,
      COALESCE(ct.name, CASE WHEN k.contact_id IS NULL THEN 'Unattributed ledger entries' ELSE 'Unknown vendor' END)::text AS contact_name,
      p.open_amt::numeric AS projection_open,
      cd.credit_amt::numeric AS projection_credit,
      (COALESCE(p.open_amt, 0) - COALESCE(cd.credit_amt, 0))::numeric AS projection_net_naive,
      CASE WHEN (p.contact_id IS NOT NULL AND p.open_amt IS NULL)
             OR (cd.contact_id IS NOT NULL AND cd.credit_amt IS NULL)
           THEN NULL
           ELSE (COALESCE(p.open_amt, 0) - COALESCE(cd.credit_amt, 0))
      END::numeric AS projection_net,
      COALESCE(l.net_amt, 0)::numeric AS ledger_net,
      CASE WHEN (p.contact_id IS NOT NULL AND p.open_amt IS NULL)
             OR (cd.contact_id IS NOT NULL AND cd.credit_amt IS NULL)
           THEN NULL
           ELSE ((COALESCE(p.open_amt, 0) - COALESCE(cd.credit_amt, 0)) - COALESCE(l.net_amt, 0))
      END::numeric AS variance,
      CASE
        WHEN (p.contact_id IS NOT NULL AND p.open_amt IS NULL)
          OR (cd.contact_id IS NOT NULL AND cd.credit_amt IS NULL) THEN 'unconvertible_currency'
        WHEN k.contact_id IS NULL THEN 'unattributed_ledger'
        WHEN p.contact_id IS NULL AND cd.contact_id IS NULL THEN 'missing_from_projection'
        WHEN l.contact_id IS NULL THEN 'missing_from_ledger'
        ELSE 'amount_mismatch'
      END::text AS reason,
      COALESCE(p.doc_count, 0)::int AS document_count,
      COALESCE(p.unconvertible, 0)::int AS unconvertible_document_count
    FROM keys k
    LEFT JOIN proj   p  ON p.contact_id  IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN cred   cd ON cd.contact_id IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN ledger l  ON l.contact_id  IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN public.contacts ct ON ct.id = k.contact_id
  )
  SELECT r.contact_id, r.contact_name,
         r.projection_open::numeric(14,2),
         r.projection_credit::numeric(14,2),
         r.projection_net::numeric(14,2),
         r.ledger_net::numeric(14,2),
         r.variance::numeric(14,2),
         r.reason,
         r.document_count,
         r.unconvertible_document_count
    FROM rows_out r
   WHERE r.variance IS NULL OR ABS(r.variance) > 0.01
   ORDER BY r.variance IS NULL DESC, ABS(COALESCE(r.variance, 0)) DESC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(p_organization_id uuid, p_business_id uuid, p_branch_id uuid DEFAULT NULL::uuid, p_as_of date DEFAULT CURRENT_DATE, p_search text DEFAULT NULL::text, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_search text := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.finance_can_read_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  WITH open_items AS (
    SELECT * FROM public.finance_ap_open_items_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
  ),
  vendor_credit AS (
    SELECT contact_id AS vendor_id,
           (CASE WHEN COUNT(*) FILTER (WHERE base_credit_amount IS NULL) > 0
                 THEN NULL ELSE SUM(base_credit_amount) END)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
     GROUP BY contact_id
  ),
  vendor_ids AS (
    SELECT contact_id AS vendor_id FROM open_items
    UNION
    SELECT vendor_id FROM vendor_credit
  ),
  -- ADR 0136: a bucket containing an unconvertible document has no honest
  -- base-currency total. NULL is the answer; the count says why.
  bill_rows AS (
    SELECT
      o.contact_id AS vendor_id,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'not_due') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'not_due'), 0) END)::numeric AS not_due_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'current') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'current'), 0) END)::numeric AS current_amt,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days30') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days30'), 0) END)::numeric AS d30,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days60') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days60'), 0) END)::numeric AS d60,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL AND o.aging_bucket = 'days90') > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days90'), 0) END)::numeric AS d90,
      (CASE WHEN COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL) > 0
            THEN NULL ELSE COALESCE(SUM(o.base_residual_amount), 0) END)::numeric AS gross_amt,
      COUNT(*) FILTER (WHERE o.base_residual_amount IS NULL)::int AS unconvertible_count,
      jsonb_agg(
        jsonb_build_object(
          'id',               o.document_id,
          'bill_number',      COALESCE(o.document_number, LEFT(o.document_id::text, 8)),
          'document_date',    o.document_date,
          'due_date',         o.due_date,
          'document_total',   o.document_total,
          'paid',             o.paid_amount,
          'credited',         o.credited_amount,
          'balance',          o.residual_amount,
          'base_balance',     o.base_residual_amount,
          'currency',         o.currency,
          'days_past_due',    o.days_past_due,
          'bucket',           o.aging_bucket,
          'source_kind',      o.source_kind,
          'journal_entry_id', o.journal_entry_id
        ) ORDER BY o.due_date ASC NULLS LAST
      ) AS bills
    FROM open_items o
    GROUP BY o.contact_id
  ),
  vendor_rows AS (
    SELECT
      vi.vendor_id,
      COALESCE(c.name, 'Unknown Vendor') AS vendor_name,
      br.not_due_amt AS not_due_amt,
      br.current_amt AS current_amt,
      br.d30 AS d30,
      br.d60 AS d60,
      br.d90 AS d90,
      br.gross_amt AS gross_amt,
      vcr.credit_amt AS credit_amt,
      CASE WHEN (br.vendor_id IS NOT NULL AND br.gross_amt IS NULL)
                OR (vcr.vendor_id IS NOT NULL AND vcr.credit_amt IS NULL)
           THEN NULL
           ELSE COALESCE(br.gross_amt, 0) - COALESCE(vcr.credit_amt, 0)
      END AS total_amt,
      COALESCE(br.unconvertible_count, 0) AS unconvertible_count,
      COALESCE(br.bills, '[]'::jsonb) AS bills
    FROM vendor_ids vi
    LEFT JOIN bill_rows br ON br.vendor_id = vi.vendor_id
    LEFT JOIN vendor_credit vcr ON vcr.vendor_id = vi.vendor_id
    LEFT JOIN public.contacts c ON c.id = vi.vendor_id
  ),
  matched AS (
    SELECT * FROM vendor_rows
     WHERE v_search IS NULL OR vendor_name ILIKE '%' || v_search || '%'
  ),
  page AS (
    SELECT * FROM matched
     ORDER BY total_amt DESC NULLS FIRST, vendor_name ASC
     OFFSET v_offset
     LIMIT CASE WHEN p_limit IS NULL OR p_limit <= 0 THEN NULL ELSE p_limit END
  ),
  -- A total over a population containing an unconvertible member is itself
  -- unavailable, not the sum of the convertible remainder.
  totals AS (
    SELECT
      (CASE WHEN COUNT(*) FILTER (WHERE not_due_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(not_due_amt), 0) END) AS not_due,
      (CASE WHEN COUNT(*) FILTER (WHERE current_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(current_amt), 0) END) AS current_b,
      (CASE WHEN COUNT(*) FILTER (WHERE d30 IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(d30), 0) END) AS d30,
      (CASE WHEN COUNT(*) FILTER (WHERE d60 IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(d60), 0) END) AS d60,
      (CASE WHEN COUNT(*) FILTER (WHERE d90 IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(d90), 0) END) AS d90,
      (CASE WHEN COUNT(*) FILTER (WHERE gross_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(gross_amt), 0) END) AS gross,
      (CASE WHEN COUNT(*) FILTER (WHERE credit_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(credit_amt), 0) END) AS credit,
      (CASE WHEN COUNT(*) FILTER (WHERE total_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(total_amt), 0) END) AS total,
      COUNT(*)::int AS vendor_count,
      COALESCE(SUM(unconvertible_count), 0)::int AS unconvertible_count
    FROM vendor_rows
  )
  SELECT jsonb_build_object(
    'as_of', p_as_of,
    'currency', (SELECT base_currency FROM public.businesses WHERE id = p_business_id),
    'vendors', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'vendor_id',   vendor_id,
          'vendor_name', vendor_name,
          'not_due',     not_due_amt,
          'current',     current_amt,
          'days30',      d30,
          'days60',      d60,
          'days90',      d90,
          'gross',       gross_amt,
          'credit',      credit_amt,
          'total',       total_amt,
          'unconvertible_count', unconvertible_count,
          'bills',       bills
        ) ORDER BY total_amt DESC NULLS FIRST, vendor_name ASC
      ) FROM page
    ), '[]'::jsonb),
    'page', jsonb_build_object(
      'limit',  p_limit,
      'offset', v_offset,
      'search', v_search,
      'returned', (SELECT COUNT(*)::int FROM page),
      'has_more', (SELECT COUNT(*) FROM matched) > v_offset + (SELECT COUNT(*) FROM page)
    ),
    'filtered', jsonb_build_object(
      'vendor_count', (SELECT COUNT(*)::int FROM matched),
      'total',        (SELECT CASE WHEN COUNT(*) FILTER (WHERE total_amt IS NULL) > 0 THEN NULL ELSE COALESCE(SUM(total_amt), 0) END FROM matched)
    ),
    'totals', jsonb_build_object(
      'not_due',      (SELECT not_due FROM totals),
      'current',      (SELECT current_b FROM totals),
      'days30',       (SELECT d30 FROM totals),
      'days60',       (SELECT d60 FROM totals),
      'days90',       (SELECT d90 FROM totals),
      'gross',        (SELECT gross FROM totals),
      'credit',       (SELECT credit FROM totals),
      'total',        (SELECT total FROM totals),
      'vendor_count', (SELECT vendor_count FROM totals),
      'unconvertible_count', (SELECT unconvertible_count FROM totals)
    )
  ) INTO v_result;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'page', jsonb_build_object('limit', p_limit, 'offset', v_offset, 'search', v_search, 'returned', 0, 'has_more', false),
    'filtered', jsonb_build_object('vendor_count', 0, 'total', 0),
    'totals', jsonb_build_object(
      'not_due',0,'current',0,'days30',0,'days60',0,'days90',0,
      'gross',0,'credit',0,'total',0,'vendor_count',0,'unconvertible_count',0
    )
  ));
END
$function$;