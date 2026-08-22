-- ============================================================
-- Budgets Phase 4 defect closure: D1 (reversed entries), D2
-- (non-January fiscal years), D3 (period-keyed plan/actual match)
-- ============================================================

-- Shared period authority: the monthly fiscal periods that constitute a
-- budget's fiscal year for a given business. Preference order:
--   1. the business's own period_type='year' row for that fiscal year
--   2. a window derived from businesses.fiscal_year_start (FY is labelled
--      by the calendar year in which it STARTS)
CREATE OR REPLACE FUNCTION public.budget_fiscal_months(_business_id uuid, _fiscal_year int)
RETURNS TABLE(
  period_id uuid,
  start_date date,
  end_date date,
  status text,
  period_month int,
  period_ordinal int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _win_start date;
  _win_end date;
  _fys int;
BEGIN
  SELECT fp.start_date, fp.end_date
  INTO _win_start, _win_end
  FROM public.fiscal_periods fp
  WHERE fp.business_id = _business_id
    AND fp.period_type = 'year'
    AND _fiscal_year BETWEEN EXTRACT(YEAR FROM fp.start_date)::int
                         AND EXTRACT(YEAR FROM fp.end_date)::int
  ORDER BY (EXTRACT(YEAR FROM fp.start_date)::int = _fiscal_year) DESC, fp.start_date
  LIMIT 1;

  IF _win_start IS NULL THEN
    SELECT COALESCE(b.fiscal_year_start, 1) INTO _fys
    FROM public.businesses b WHERE b.id = _business_id;
    _fys := COALESCE(_fys, 1);
    IF _fys < 1 OR _fys > 12 THEN
      _fys := 1;
    END IF;
    _win_start := make_date(_fiscal_year, _fys, 1);
    _win_end := (_win_start + INTERVAL '1 year' - INTERVAL '1 day')::date;
  END IF;

  RETURN QUERY
  SELECT fp.id,
         fp.start_date,
         fp.end_date,
         fp.status::text,
         EXTRACT(MONTH FROM fp.start_date)::int,
         ROW_NUMBER() OVER (ORDER BY fp.start_date)::int
  FROM public.fiscal_periods fp
  WHERE fp.business_id = _business_id
    AND fp.period_type = 'month'
    AND fp.start_date >= _win_start
    AND fp.start_date <= _win_end;
END;
$function$;

REVOKE ALL ON FUNCTION public.budget_fiscal_months(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.budget_fiscal_months(uuid, int) TO service_role;

-- ------------------------------------------------------------
-- Budget line normalization uses the same period authority.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._budget_items_normalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  b record;
  fp record;
  acct record;
  revising boolean;
BEGIN
  SELECT id, organization_id, business_id, fiscal_year, status
  INTO b
  FROM public.budgets
  WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget % not found', COALESCE(NEW.budget_id, OLD.budget_id);
  END IF;

  revising := COALESCE(current_setting('app.budget_revision', true), '') = b.id::text;

  IF b.status = 'closed' THEN
    RAISE EXCEPTION 'This budget is closed; its lines are read-only.' USING ERRCODE = '23514';
  END IF;

  IF b.status = 'active' AND NOT revising THEN
    RAISE EXCEPTION 'This budget is active. Record a budget revision instead of editing lines directly.'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  NEW.business_id := b.business_id;

  SELECT id, business_id, account_type INTO acct
  FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % not found', NEW.account_id;
  END IF;
  IF acct.business_id <> b.business_id THEN
    RAISE EXCEPTION 'Account % belongs to a different business than this budget', NEW.account_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.fiscal_period_id IS NULL THEN
    SELECT m.period_id AS id, m.start_date, m.status
    INTO fp
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
    WHERE m.period_month = NEW.period_month
    ORDER BY m.start_date
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No monthly fiscal period exists for % / month % in this business. Provision fiscal periods first.',
        b.fiscal_year, NEW.period_month USING ERRCODE = '23503';
    END IF;
    NEW.fiscal_period_id := fp.id;
  ELSE
    SELECT m.period_id AS id, m.start_date, m.status
    INTO fp
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
    WHERE m.period_id = NEW.fiscal_period_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fiscal period % is not a monthly period of this budget''s business and fiscal year', NEW.fiscal_period_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- period_month / fiscal_year are derived display values
  NEW.period_month := EXTRACT(MONTH FROM fp.start_date)::int;

  IF fp.status <> 'open' THEN
    RAISE EXCEPTION 'Accounting period is % ; budget lines for it cannot be changed.', fp.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.budgeted_amount IS NULL OR NEW.budgeted_amount < 0 THEN
    RAISE EXCEPTION 'Budgeted amount must be zero or positive' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- ------------------------------------------------------------
-- The one authoritative budget variance report.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_budget_variance_report(uuid);

CREATE OR REPLACE FUNCTION public.get_budget_variance_report(_budget_id uuid)
RETURNS TABLE(
  account_id uuid,
  account_code text,
  account_name text,
  account_type text,
  period_month integer,
  period_ordinal integer,
  fiscal_period_id uuid,
  period_start date,
  period_end date,
  period_status text,
  budgeted_amount numeric,
  actual_amount numeric,
  variance_amount numeric,
  variance_percent numeric,
  is_favourable boolean,
  is_unbudgeted boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_read(_budget_id);

  RETURN QUERY
  WITH periods AS (
    -- The business's own accounting calendar is the period authority,
    -- including for fiscal years that do not start in January.
    SELECT m.period_id,
           m.start_date,
           m.end_date,
           m.status,
           m.period_month,
           m.period_ordinal
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
  ),
  ledger AS (
    SELECT jel.account_id,
           p.period_id,
           SUM(
             CASE
               WHEN a.account_type IN ('asset', 'expense')
                 THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
               ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
             END
           ) AS actual_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
    JOIN periods p ON je.entry_date BETWEEN p.start_date AND p.end_date
    WHERE je.business_id = b.business_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND COALESCE(je.is_closing, false) = false
      AND COALESCE(je.is_closing_entry, false) = false
      AND COALESCE(je.is_opening_entry, false) = false
      AND COALESCE(je.is_sample_data, false) = false
      AND COALESCE(jel.is_sample_data, false) = false
      AND (b.branch_id IS NULL OR je.branch_id = b.branch_id)
    GROUP BY jel.account_id, p.period_id
  ),
  planned AS (
    -- fiscal_period_id is the join key: the plan and the ledger are matched
    -- on the accounting period, never on a calendar month number.
    SELECT bi.account_id,
           bi.fiscal_period_id AS period_id,
           SUM(bi.budgeted_amount) AS budgeted_amount
    FROM public.budget_items bi
    WHERE bi.budget_id = _budget_id
      AND bi.fiscal_period_id IS NOT NULL
    GROUP BY bi.account_id, bi.fiscal_period_id
  ),
  combined AS (
    SELECT COALESCE(pl.account_id, l.account_id) AS account_id,
           COALESCE(pl.period_id, l.period_id) AS period_id,
           COALESCE(pl.budgeted_amount, 0) AS budgeted_amount,
           COALESCE(l.actual_amount, 0) AS actual_amount,
           pl.account_id IS NULL AS is_unbudgeted
    FROM planned pl
    FULL OUTER JOIN ledger l
      ON l.account_id = pl.account_id
     AND l.period_id = pl.period_id
  )
  SELECT c.account_id,
         a.code,
         a.name,
         a.account_type::text,
         p.period_month,
         p.period_ordinal,
         c.period_id,
         p.start_date,
         p.end_date,
         p.status,
         c.budgeted_amount,
         c.actual_amount,
         -- Variance is expressed so that positive is always FAVOURABLE:
         -- spending less than planned on a cost account, or earning more
         -- than planned on a revenue account.
         CASE
           WHEN a.account_type IN ('asset', 'expense')
             THEN c.budgeted_amount - c.actual_amount
           ELSE c.actual_amount - c.budgeted_amount
         END AS variance_amount,
         CASE
           WHEN c.budgeted_amount = 0 THEN NULL
           ELSE ROUND(
             (CASE
                WHEN a.account_type IN ('asset', 'expense')
                  THEN c.budgeted_amount - c.actual_amount
                ELSE c.actual_amount - c.budgeted_amount
              END / ABS(c.budgeted_amount)) * 100, 2)
         END AS variance_percent,
         (CASE
            WHEN a.account_type IN ('asset', 'expense')
              THEN c.budgeted_amount - c.actual_amount
            ELSE c.actual_amount - c.budgeted_amount
          END) >= 0 AS is_favourable,
         c.is_unbudgeted
  FROM combined c
  JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN periods p ON p.period_id = c.period_id
  -- Unbudgeted noise is limited to operating performance accounts; a budget
  -- is a P&L plan, so balance-sheet movement is not reported as overspend.
  WHERE NOT c.is_unbudgeted
     OR (a.account_type IN ('income', 'expense') AND c.actual_amount <> 0)
  ORDER BY p.period_ordinal, a.code;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_budget_variance_report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_budget_variance_report(uuid) TO service_role;