
-- =========================================================================
-- Phase 1: point-in-time AP open items, anchored on the AP subledger
-- =========================================================================
CREATE OR REPLACE FUNCTION public.finance_ap_open_items_as_of(
  _org_id      uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id   uuid DEFAULT NULL,
  _as_of       date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  organization_id uuid,
  business_id uuid,
  branch_id uuid,
  document_id uuid,
  document_number text,
  contact_id uuid,
  document_date date,
  due_date date,
  document_total numeric,
  paid_amount numeric,
  credited_amount numeric,
  residual_amount numeric,
  document_status text,
  journal_entry_id uuid,
  currency text,
  exchange_rate numeric,
  base_residual_amount numeric,
  source_kind text,
  aging_bucket text,
  days_past_due int
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bill_je AS (
    -- Obligation is recognised only once the bill's AP journal entry is
    -- posted with an entry date on or before the as-of date.
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
    -- Settlement counts on its payment date, not "now".
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
      -- Explicit rule: a bill with no due date is due on its document date.
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
    -- Status is NOT used to decide openness: the residual decides. Only
    -- documents that were never a real obligation are excluded.
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
      AND s.entry_date <= _as_of
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
$function$;

GRANT EXECUTE ON FUNCTION public.finance_ap_open_items_as_of(uuid,uuid,uuid,date) TO authenticated, service_role;

-- Point-in-time, branch-scoped unapplied vendor credit.
CREATE OR REPLACE FUNCTION public.finance_ap_vendor_credit_as_of(
  _org_id      uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id   uuid DEFAULT NULL,
  _as_of       date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  organization_id uuid,
  business_id uuid,
  branch_id uuid,
  contact_id uuid,
  currency text,
  credit_amount numeric,
  base_credit_amount numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH notes AS (
    SELECT vcn.id, vcn.organization_id, vcn.business_id, vcn.branch_id,
           vcn.vendor_id AS contact_id,
           COALESCE(NULLIF(vcn.currency,''), 'USD') AS currency,
           vcn.total::numeric AS total
      FROM public.vendor_credit_notes vcn
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
  )
  SELECT n.organization_id, n.business_id, n.branch_id, n.contact_id, n.currency,
         SUM(n.total - COALESCE(a.amount,0))::numeric(14,2) AS credit_amount,
         SUM(public.to_base_amount(n.business_id, n.currency, n.total - COALESCE(a.amount,0), _as_of))::numeric(14,2) AS base_credit_amount
    FROM notes n
    LEFT JOIN applied a ON a.credit_note_id = n.id
   GROUP BY n.organization_id, n.business_id, n.branch_id, n.contact_id, n.currency
  HAVING SUM(n.total - COALESCE(a.amount,0)) > 0.01
$function$;

GRANT EXECUTE ON FUNCTION public.finance_ap_vendor_credit_as_of(uuid,uuid,uuid,date) TO authenticated, service_role;

-- =========================================================================
-- Phase 2: one AP aging engine
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT public.is_org_member(auth.uid(), p_organization_id) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  WITH open_items AS (
    SELECT * FROM public.finance_ap_open_items_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
  ),
  vendor_credit AS (
    SELECT contact_id AS vendor_id,
           SUM(base_credit_amount)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
     GROUP BY contact_id
  ),
  vendor_ids AS (
    SELECT contact_id AS vendor_id FROM open_items
    UNION
    SELECT vendor_id FROM vendor_credit
  ),
  bill_rows AS (
    SELECT
      o.contact_id AS vendor_id,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'not_due'), 0)::numeric AS not_due_amt,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'current'), 0)::numeric AS current_amt,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days30'),  0)::numeric AS d30,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days60'),  0)::numeric AS d60,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days90'),  0)::numeric AS d90,
      COALESCE(SUM(o.base_residual_amount), 0)::numeric AS gross_amt,
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
      COALESCE(br.not_due_amt, 0) AS not_due_amt,
      COALESCE(br.current_amt, 0) AS current_amt,
      COALESCE(br.d30, 0) AS d30,
      COALESCE(br.d60, 0) AS d60,
      COALESCE(br.d90, 0) AS d90,
      COALESCE(br.gross_amt, 0) AS gross_amt,
      COALESCE(vcr.credit_amt, 0) AS credit_amt,
      COALESCE(br.gross_amt, 0) - COALESCE(vcr.credit_amt, 0) AS total_amt,
      COALESCE(br.bills, '[]'::jsonb) AS bills
    FROM vendor_ids vi
    LEFT JOIN bill_rows br ON br.vendor_id = vi.vendor_id
    LEFT JOIN vendor_credit vcr ON vcr.vendor_id = vi.vendor_id
    LEFT JOIN public.contacts c ON c.id = vi.vendor_id
  )
  SELECT jsonb_build_object(
    'as_of', p_as_of,
    'currency', (SELECT base_currency FROM public.businesses WHERE id = p_business_id),
    'vendors', COALESCE(jsonb_agg(
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
        'bills',       bills
      ) ORDER BY total_amt DESC
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'not_due',      COALESCE(SUM(not_due_amt), 0),
      'current',      COALESCE(SUM(current_amt), 0),
      'days30',       COALESCE(SUM(d30), 0),
      'days60',       COALESCE(SUM(d60), 0),
      'days90',       COALESCE(SUM(d90), 0),
      'gross',        COALESCE(SUM(gross_amt), 0),
      'credit',       COALESCE(SUM(credit_amt), 0),
      'total',        COALESCE(SUM(total_amt), 0),
      'vendor_count', COUNT(*)::int
    )
  ) INTO v_result
  FROM vendor_rows;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'totals', jsonb_build_object(
      'not_due',0,'current',0,'days30',0,'days60',0,'days90',0,
      'gross',0,'credit',0,'total',0,'vendor_count',0
    )
  ));
END
$function$;

-- KPI cards: same engine, no private aging arithmetic.
CREATE OR REPLACE FUNCTION public.get_ap_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
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
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH open_items AS (
    SELECT * FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of)
  ),
  credits AS (
    SELECT COALESCE(SUM(base_credit_amount), 0) AS amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of)
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
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE aging_bucket = 'not_due'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE aging_bucket = 'current'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE aging_bucket = 'days30'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE aging_bucket = 'days60'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE aging_bucket = 'days90'),
    (SELECT COUNT(*)::int FROM open_items WHERE days_past_due > 0),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$function$;

-- =========================================================================
-- Phase 3: reconciliation of the aging total to the AP control account
-- =========================================================================
CREATE OR REPLACE FUNCTION public.finance_ap_aging_reconciliation(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  aging_total numeric,
  control_account_balance numeric,
  variance numeric,
  in_balance boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH aging AS (
    SELECT COALESCE(SUM(base_residual_amount), 0)::numeric AS amt
      FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of)
  ),
  credits AS (
    SELECT COALESCE(SUM(base_credit_amount), 0)::numeric AS amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of)
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
    ABS(((SELECT amt FROM aging) - (SELECT amt FROM credits)) - (SELECT amt FROM control)) <= 0.01
$function$;

GRANT EXECUTE ON FUNCTION public.finance_ap_aging_reconciliation(uuid,uuid,uuid,date) TO authenticated, service_role;
