-- ─────────────────────────────────────────────────────────────
-- Phase 2: Receivables point-in-time parity with payables.
--
-- AP already has one engine — finance_ap_open_items_as_of — and every AP
-- surface reads it, so an as-of date is reproducible. AR read the plain
-- `finance_ar_open_items` view, which nets ALL payments and credit notes
-- regardless of when they happened: last month's aged receivables silently
-- reported today's residuals. This creates the AR twin of the AP engine and
-- repoints the AR consumers at it.
-- ─────────────────────────────────────────────────────────────

-- 1. finance_ar_open_items_as_of ------------------------------
-- Mirror of finance_ap_open_items_as_of, sign-flipped for receivables.
CREATE OR REPLACE FUNCTION public.finance_ar_open_items_as_of(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  organization_id uuid, business_id uuid, branch_id uuid,
  document_id uuid, document_number text, contact_id uuid,
  document_date date, due_date date,
  document_total numeric, paid_amount numeric, credited_amount numeric,
  residual_amount numeric, document_status text, journal_entry_id uuid,
  currency text, exchange_rate numeric, base_residual_amount numeric,
  source_kind text, aging_bucket text, days_past_due integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- A receivable exists only once it has hit the AR control account. The
  -- posting date, not the invoice's current status, decides whether it
  -- existed on _as_of.
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
      COALESCE(NULLIF(inv.currency, ''), biz.base_currency, 'USD') AS currency,
      -- FX honesty (ADR 0135/0136), identical to the payables engine: the
      -- document's own rate snapshot wins; a same-currency document is 1 by
      -- definition; otherwise the single rate authority answers. No 1:1 is
      -- ever fabricated for a foreign-currency document.
      CASE
        WHEN COALESCE(NULLIF(inv.exchange_rate, 0), 0) <> 0 THEN inv.exchange_rate::numeric
        WHEN COALESCE(NULLIF(inv.currency, ''), biz.base_currency, 'USD')
             = COALESCE(biz.base_currency, 'USD') THEN 1::numeric
        ELSE public.resolve_exchange_rate(
               inv.organization_id, inv.business_id,
               COALESCE(NULLIF(inv.currency, ''), biz.base_currency, 'USD'),
               _as_of)
      END AS exchange_rate,
      'invoice'::text AS source_kind
    FROM public.invoices inv
    JOIN invoice_je j       ON j.invoice_id = inv.id
    LEFT JOIN paid p        ON p.invoice_id = inv.id
    LEFT JOIN credited cr   ON cr.invoice_id = inv.id
    LEFT JOIN public.businesses biz ON biz.id = inv.business_id
    -- Deliberately NOT filtering on status = 'paid': an invoice settled after
    -- _as_of was still outstanding on _as_of. Residual, computed from
    -- as-of-dated receipts and credits, is the only authority.
    WHERE inv.status::text NOT IN ('draft','void','voided','cancelled')
  ),
  -- Manual AR journals: receivables posted straight to the control account.
  -- Both directions are collected; net > 0 is a receivable, net < 0 is a
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
      SUM(s.debit - s.credit)::numeric AS net,
      COALESCE(MAX(biz.base_currency), 'USD') AS currency
    FROM public.ar_subledger_entries s
    LEFT JOIN public.businesses biz ON biz.id = s.business_id
    WHERE s.contact_id IS NOT NULL
      AND s.entry_date <= _as_of
      AND (s.source_type IS NULL OR s.source_type NOT IN
           ('invoice','payment','customer_payment','credit_note','customer_refund','refund'))
    GROUP BY s.organization_id, s.business_id, s.branch_id, s.journal_entry_id, s.contact_id
  ),
  manual_settlements AS (
    -- Every column is qualified: bare names would collide with this
    -- function's OUT parameters and abort the query.
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

REVOKE ALL ON FUNCTION public.finance_ar_open_items_as_of(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_ar_open_items_as_of(uuid, uuid, uuid, date) TO authenticated, service_role;

-- 2. finance_ar_customer_credit_as_of --------------------------
-- The `finance_ar_customer_credit` view reads `customer_credit_balances`,
-- which is a LIVE balance — unusable for an as-of report. The movements
-- table is append-only, so the balance on any date is replayable from it.
CREATE OR REPLACE FUNCTION public.finance_ar_customer_credit_as_of(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  organization_id uuid, business_id uuid, branch_id uuid,
  contact_id uuid, currency text,
  credit_amount numeric, base_credit_amount numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH movements AS (
    -- Sign convention is fixed by _ccm_project_balance: 'issue' increases the
    -- customer's credit, every other kind (apply/refund/expire) consumes it.
    SELECT m.organization_id,
           m.business_id,
           m.contact_id,
           COALESCE(NULLIF(m.currency, ''), 'USD') AS currency,
           SUM(CASE WHEN m.kind = 'issue' THEN m.amount ELSE -m.amount END)::numeric AS balance
      FROM public.customer_credit_movements m
     WHERE m.organization_id = _org_id
       AND (_business_id IS NULL OR m.business_id = _business_id)
       AND (_branch_id IS NULL OR m.branch_id = _branch_id)
       AND m.created_at::date <= _as_of
     GROUP BY m.organization_id, m.business_id, m.contact_id,
              COALESCE(NULLIF(m.currency, ''), 'USD')
  )
  SELECT mv.organization_id,
         mv.business_id,
         NULL::uuid AS branch_id,
         mv.contact_id,
         mv.currency,
         mv.balance::numeric(14,2) AS credit_amount,
         public.to_base_amount(mv.business_id, mv.currency, mv.balance, _as_of)::numeric(14,2)
           AS base_credit_amount
    FROM movements mv
   WHERE mv.balance > 0.01;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_ar_customer_credit_as_of(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_ar_customer_credit_as_of(uuid, uuid, uuid, date) TO authenticated, service_role;

-- 3. finance_ar_aging_reconciliation ---------------------------
-- Twin of finance_ap_aging_reconciliation: the aging total must equal the AR
-- control-account balance at the same date, or the report is not trustworthy.
CREATE OR REPLACE FUNCTION public.finance_ar_aging_reconciliation(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  aging_total numeric, control_account_balance numeric,
  variance numeric, in_balance boolean
)
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
    SELECT COALESCE(SUM(o.base_residual_amount), 0)::numeric AS amt
      FROM public.finance_ar_open_items_as_of(_org_id, _business_id, _branch_id, _as_of) o
  ),
  credits AS (
    SELECT COALESCE(SUM(c.base_credit_amount), 0)::numeric AS amt
      FROM public.finance_ar_customer_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
  ),
  control AS (
    -- AR is a debit-balance control account: debit - credit (AP is the
    -- reverse).
    SELECT COALESCE(SUM(s.debit - s.credit), 0)::numeric AS amt
      FROM public.ar_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id IS NULL OR s.branch_id = _branch_id)
       AND s.entry_date <= _as_of
  )
  SELECT
    ((SELECT amt FROM aging) - (SELECT amt FROM credits))::numeric(14,2),
    (SELECT amt FROM control)::numeric(14,2),
    (((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control))::numeric(14,2),
    ABS(((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control)) <= 0.01;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_ar_aging_reconciliation(uuid, uuid, uuid, date) TO authenticated, service_role;

-- 4. Repoint get_ar_summary at the engine ----------------------
-- Same shape as Phase 1, but every figure is now as-of-dated. `_as_of` also
-- bounds the unposted-document probe, so the tile cannot mix a historical
-- aging with today's unposted backlog.
CREATE OR REPLACE FUNCTION public.get_ar_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  open_document_count integer,
  total_residual numeric,
  not_due numeric,
  current_bucket numeric,
  days30 numeric,
  days60 numeric,
  days90 numeric,
  overdue_count integer,
  unposted_document_count integer,
  unposted_amount numeric
)
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
    SELECT COALESCE(SUM(c.base_credit_amount), 0)::numeric AS amt
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
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o WHERE o.aging_bucket = 'not_due'),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o WHERE o.aging_bucket = 'current') - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o WHERE o.aging_bucket = 'days30'),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o WHERE o.aging_bucket = 'days60'),
    (SELECT COALESCE(SUM(o.base_residual_amount), 0) FROM open_items o WHERE o.aging_bucket = 'days90'),
    (SELECT COUNT(*)::int FROM open_items o WHERE o.aging_bucket <> 'not_due'),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) TO authenticated, service_role;

-- 5. Repoint the Aged Receivables detail rows ------------------
-- The AR branch now reads the engine instead of the always-today view, so AR
-- and AP are symmetric inside one function. AP branch unchanged.
CREATE OR REPLACE FUNCTION public.get_ar_ap_aging_from_ledger(
  _org_id uuid, _business_id uuid, _report_type text, _as_of_date date,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  contact_id uuid, contact_name text, company text, email text,
  document_id uuid, document_number text, document_date date, due_date date,
  document_total numeric, applied_amount numeric, residual_amount numeric,
  days_overdue integer, bucket text, journal_entry_id uuid
)
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
           oi.document_total, (oi.paid_amount + oi.credited_amount) AS applied_amount,
           oi.base_residual_amount AS residual_amount,
           oi.days_past_due AS days_overdue,
           oi.aging_bucket AS bucket,
           oi.journal_entry_id
      FROM public.finance_ar_open_items_as_of(_org_id, _business_id, _branch_id, _as_of_date) oi
     WHERE _report_type = 'ar'
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
      FROM public.finance_ar_customer_credit_as_of(_org_id, _business_id, _branch_id, _as_of_date) cc
     WHERE _report_type = 'ar'
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

REVOKE ALL ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_ap_aging_from_ledger(uuid, uuid, text, date, uuid) TO authenticated, service_role;