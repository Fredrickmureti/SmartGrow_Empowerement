-- =====================================================================
-- Partner Ledger — server-owned engine.
--
-- Replaces the browser-side implementation that paged every ledger row
-- into the client and computed opening / running / closing balances in
-- JavaScript. Balances are accounting output and belong in SQL, next to
-- the sub-ledger they project.
--
-- Source of truth: `customer_ledger_entries` / `vendor_ledger_entries`
-- (posted `journal_entry_lines` on the AR / AP control accounts). Their
-- `debit` / `credit` are already BASE-currency amounts — the same values
-- `finance_ar/ap_aging_reconciliation` ties to the control account — so
-- no further FX conversion is applied here. Document currency lives in
-- `original_debit` / `original_credit` and is not a ledger balance.
--
-- Branch scoping is strict (`branch_id = _branch_id`), identical to the
-- aging engines. The old page used `branch_id = X OR branch_id IS NULL`,
-- which silently absorbed unbranched entries into a branch view.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.finance_partner_ledger(
  _org_id      uuid,
  _business_id uuid    DEFAULT NULL,
  _branch_id   uuid    DEFAULT NULL,
  _side        text    DEFAULT 'customer',
  _from        date    DEFAULT NULL,
  _to          date    DEFAULT CURRENT_DATE,
  _contact_id  uuid    DEFAULT NULL,
  _search      text    DEFAULT NULL,
  _limit       integer DEFAULT NULL,
  _offset      integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result  jsonb;
  v_side    text := CASE WHEN COALESCE(_side, 'customer') IN ('supplier', 'vendor')
                         THEN 'vendor' ELSE 'customer' END;
  -- AR is a debit-balance control account, AP a credit-balance one.
  v_sign    numeric := CASE WHEN v_side = 'vendor' THEN -1 ELSE 1 END;
  v_search  text := NULLIF(BTRIM(COALESCE(_search, '')), '');
  v_offset  int  := GREATEST(COALESCE(_offset, 0), 0);
  v_from    date := _from;
  v_to      date := COALESCE(_to, CURRENT_DATE);
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  WITH entries AS (
    SELECT c.contact_id, c.entry_date, c.doc_type, c.doc_id, c.doc_ref,
           c.debit, c.credit, c.currency, c.created_at, c.journal_entry_id
      FROM public.customer_ledger_entries c
     WHERE v_side = 'customer'
       AND c.organization_id = _org_id
       AND (_business_id IS NULL OR c.business_id = _business_id)
       AND (_branch_id   IS NULL OR c.branch_id   = _branch_id)
       AND (_contact_id  IS NULL OR c.contact_id  = _contact_id)
       AND c.contact_id IS NOT NULL
       AND c.entry_date <= v_to
    UNION ALL
    SELECT v.contact_id, v.entry_date, v.doc_type, v.doc_id, v.doc_ref,
           v.debit, v.credit, v.currency, v.created_at, NULL::uuid
      FROM public.vendor_ledger_entries v
     WHERE v_side = 'vendor'
       AND v.organization_id = _org_id
       AND (_business_id IS NULL OR v.business_id = _business_id)
       AND (_branch_id   IS NULL OR v.branch_id   = _branch_id)
       AND (_contact_id  IS NULL OR v.contact_id  = _contact_id)
       AND v.contact_id IS NOT NULL
       AND v.entry_date <= v_to
  ),
  -- Everything strictly before the period start folds into opening balance.
  opening AS (
    SELECT e.contact_id,
           COALESCE(SUM(v_sign * (e.debit - e.credit)), 0)::numeric AS opening_balance
      FROM entries e
     WHERE v_from IS NOT NULL AND e.entry_date < v_from
     GROUP BY e.contact_id
  ),
  period AS (
    SELECT e.*
      FROM entries e
     WHERE v_from IS NULL OR e.entry_date >= v_from
  ),
  -- Running balance is a SQL window over (partner, date, insertion order).
  movements AS (
    SELECT p.contact_id, p.entry_date, p.doc_type, p.doc_id, p.doc_ref,
           p.debit, p.credit, p.currency, p.journal_entry_id,
           COALESCE(o.opening_balance, 0)
             + SUM(v_sign * (p.debit - p.credit)) OVER (
                 PARTITION BY p.contact_id
                 ORDER BY p.entry_date, p.created_at, p.doc_id
                 ROWS UNBOUNDED PRECEDING
               ) AS running_balance
      FROM period p
      LEFT JOIN opening o ON o.contact_id = p.contact_id
  ),
  period_totals AS (
    SELECT p.contact_id,
           COALESCE(SUM(p.debit), 0)::numeric  AS total_debit,
           COALESCE(SUM(p.credit), 0)::numeric AS total_credit,
           COUNT(*)::int                       AS movement_count
      FROM period p
     GROUP BY p.contact_id
  ),
  partner_ids AS (
    SELECT contact_id FROM opening
    UNION
    SELECT contact_id FROM period_totals
  ),
  partner_rows AS (
    SELECT
      pi.contact_id,
      COALESCE(ct.name, 'Unknown Partner')      AS contact_name,
      COALESCE(o.opening_balance, 0)            AS opening_balance,
      COALESCE(pt.total_debit, 0)               AS total_debit,
      COALESCE(pt.total_credit, 0)              AS total_credit,
      COALESCE(pt.movement_count, 0)            AS movement_count,
      COALESCE(o.opening_balance, 0)
        + v_sign * (COALESCE(pt.total_debit, 0) - COALESCE(pt.total_credit, 0))
                                                AS closing_balance
      FROM partner_ids pi
      LEFT JOIN opening        o  ON o.contact_id  = pi.contact_id
      LEFT JOIN period_totals  pt ON pt.contact_id = pi.contact_id
      LEFT JOIN public.contacts ct ON ct.id        = pi.contact_id
  ),
  matched AS (
    SELECT * FROM partner_rows
     WHERE v_search IS NULL OR contact_name ILIKE '%' || v_search || '%'
  ),
  page AS (
    SELECT * FROM matched
     ORDER BY contact_name ASC, contact_id ASC
     OFFSET v_offset
     LIMIT CASE WHEN _limit IS NULL OR _limit <= 0 THEN NULL ELSE _limit END
  )
  SELECT jsonb_build_object(
    'side',      v_side,
    'from',      v_from,
    'to',        v_to,
    'currency',  (SELECT base_currency FROM public.businesses WHERE id = _business_id),
    'partners',  COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'contact_id',      pg.contact_id,
          'contact_name',    pg.contact_name,
          'opening_balance', pg.opening_balance,
          'total_debit',     pg.total_debit,
          'total_credit',    pg.total_credit,
          'closing_balance', pg.closing_balance,
          'movement_count',  pg.movement_count,
          'transactions', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'entry_date',       m.entry_date,
                'doc_type',         m.doc_type,
                'doc_id',           m.doc_id,
                'doc_ref',          m.doc_ref,
                'debit',            m.debit,
                'credit',           m.credit,
                'currency',         m.currency,
                'journal_entry_id', m.journal_entry_id,
                'running_balance',  m.running_balance
              ) ORDER BY m.entry_date ASC, m.doc_id ASC
            )
              FROM movements m
             WHERE m.contact_id = pg.contact_id
          ), '[]'::jsonb)
        ) ORDER BY pg.contact_name ASC, pg.contact_id ASC
      ) FROM page pg
    ), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
        'opening_balance', COALESCE(SUM(opening_balance), 0),
        'total_debit',     COALESCE(SUM(total_debit), 0),
        'total_credit',    COALESCE(SUM(total_credit), 0),
        'closing_balance', COALESCE(SUM(closing_balance), 0),
        'partner_count',   COUNT(*)
      ) FROM matched
    ),
    'page', jsonb_build_object(
      'limit',    CASE WHEN _limit IS NULL OR _limit <= 0 THEN NULL ELSE _limit END,
      'offset',   v_offset,
      'search',   v_search,
      'returned', (SELECT COUNT(*) FROM page),
      'has_more', (SELECT COUNT(*) FROM matched) > v_offset + (SELECT COUNT(*) FROM page)
    )
  )
  INTO v_result;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_partner_ledger(uuid, uuid, uuid, text, date, date, uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_partner_ledger(uuid, uuid, uuid, text, date, date, uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_partner_ledger(uuid, uuid, uuid, text, date, date, uuid, text, integer, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.finance_partner_ledger(uuid, uuid, uuid, text, date, date, uuid, text, integer, integer) IS
'Partner Ledger engine. Opening balance, movements with a SQL running balance and closing balance per partner, in base currency, from the AR/AP sub-ledger views. Org-gated; strict branch scoping. The only Partner Ledger source — never re-aggregate balances client-side.';

-- ---------------------------------------------------------------------
-- Tie-out: does the ledger''s closing position equal the control account?
-- Same shape as finance_ar/ap_aging_reconciliation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_partner_ledger_reconciliation(
  _org_id      uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id   uuid DEFAULT NULL,
  _side        text DEFAULT 'customer',
  _to          date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  ledger_total            numeric,
  control_account_balance numeric,
  variance                numeric,
  in_balance              boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_side  text := CASE WHEN COALESCE(_side, 'customer') IN ('supplier', 'vendor')
                       THEN 'vendor' ELSE 'customer' END;
  v_to    date := COALESCE(_to, CURRENT_DATE);
  v_ledger  numeric := 0;
  v_control numeric := 0;
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  -- Ledger side: sum of every partner''s closing balance, unpaged.
  SELECT COALESCE(SUM((p ->> 'closing_balance')::numeric), 0)
    INTO v_ledger
    FROM jsonb_array_elements(
           public.finance_partner_ledger(
             _org_id, _business_id, _branch_id, v_side, NULL, v_to, NULL, NULL, NULL, 0
           ) -> 'partners'
         ) AS p;

  -- Control side: the sub-ledger projection of the GL control account.
  IF v_side = 'vendor' THEN
    SELECT COALESCE(SUM(s.credit - s.debit), 0)
      INTO v_control
      FROM public.ap_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id   IS NULL OR s.branch_id   = _branch_id)
       AND s.contact_id IS NOT NULL
       AND s.entry_date <= v_to;
  ELSE
    SELECT COALESCE(SUM(s.debit - s.credit), 0)
      INTO v_control
      FROM public.ar_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id   IS NULL OR s.branch_id   = _branch_id)
       AND s.contact_id IS NOT NULL
       AND s.entry_date <= v_to;
  END IF;

  RETURN QUERY
  SELECT v_ledger::numeric(14,2),
         v_control::numeric(14,2),
         (v_ledger - v_control)::numeric(14,2),
         ABS(v_ledger - v_control) <= 0.01;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_partner_ledger_reconciliation(uuid, uuid, uuid, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_partner_ledger_reconciliation(uuid, uuid, uuid, text, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_partner_ledger_reconciliation(uuid, uuid, uuid, text, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.finance_partner_ledger_reconciliation(uuid, uuid, uuid, text, date) IS
'Ties the Partner Ledger closing position to the AR/AP control account as of a date. Non-zero variance is a real bookkeeping finding, not a display issue.';
