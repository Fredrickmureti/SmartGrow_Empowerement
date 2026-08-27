-- Brick 5: consolidated P&L and balance sheet.
-- These add NO accounting arithmetic of their own: every figure is a
-- projection of get_consolidated_trial_balance_translated, which is the only
-- engine allowed to translate or aggregate. Anything that function refuses to
-- report, these refuse to report too.

CREATE OR REPLACE FUNCTION public.get_consolidated_statement_lines(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE(
  statement text,
  section text,
  section_order int,
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  is_residual boolean,
  is_derived boolean,
  presentation_currency text,
  amount numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH tb AS (
    SELECT * FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to)
  ),
  -- One line per account: member contributions are summed, never re-translated.
  by_account AS (
    SELECT t.account_id,
           min(t.account_code)  AS account_code,
           min(t.account_name)  AS account_name,
           t.account_type,
           bool_or(t.rate_class = 'residual')  AS is_residual,
           min(t.presentation_currency)        AS presentation_currency,
           sum(t.translated_debit)             AS translated_debit,
           sum(t.translated_credit)            AS translated_credit,
           sum(t.translated_closing)           AS translated_closing
      FROM tb t
     GROUP BY t.account_id, t.account_type
  ),
  lines AS (
    -- Income statement: the period's own movement.
    SELECT 'income_statement'::text AS statement,
           CASE WHEN a.account_type = 'income' THEN 'income' ELSE 'expense' END AS section,
           CASE WHEN a.account_type = 'income' THEN 1 ELSE 2 END AS section_order,
           a.account_id, a.account_code, a.account_name, a.account_type,
           a.is_residual, false AS is_derived, a.presentation_currency,
           CASE WHEN a.account_type = 'income'
                THEN a.translated_credit - a.translated_debit
                ELSE a.translated_debit - a.translated_credit
           END AS amount
      FROM by_account a
     WHERE a.account_type IN ('income', 'expense')

    UNION ALL

    -- Balance sheet: closing positions, signed the way the statement reads.
    SELECT 'balance_sheet',
           a.account_type::text,
           CASE a.account_type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
           a.account_id, a.account_code, a.account_name, a.account_type,
           a.is_residual, false, a.presentation_currency,
           a.translated_closing
      FROM by_account a
     WHERE a.account_type IN ('asset', 'liability', 'equity')

    UNION ALL

    -- The result earned so far this financial year is not posted to equity
    -- until the year closes, so the balance sheet carries it as its own line.
    -- Without it assets would not equal liabilities plus equity.
    SELECT 'balance_sheet', 'equity', 3,
           NULL::uuid, NULL::text, 'Result for the period', 'equity'::public.account_type,
           false, true, min(a.presentation_currency),
           COALESCE(sum(CASE WHEN a.account_type = 'income'
                             THEN a.translated_closing ELSE -a.translated_closing END), 0)
      FROM by_account a
     WHERE a.account_type IN ('income', 'expense')
    HAVING count(*) > 0
  )
  SELECT l.statement, l.section, l.section_order, l.account_id, l.account_code,
         l.account_name, l.account_type, l.is_residual, l.is_derived,
         l.presentation_currency, round(l.amount, 2)
    FROM lines l
   WHERE round(l.amount, 2) <> 0
   ORDER BY l.statement, l.section_order, l.is_derived, l.account_code NULLS LAST, l.account_name;
$$;

COMMENT ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) IS
  'Consolidated P&L and balance sheet lines in the group presentation currency, projected from get_consolidated_trial_balance_translated. No independent arithmetic; refuses whenever the trial balance refuses.';

CREATE OR REPLACE FUNCTION public.get_consolidated_statement_totals(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE(
  presentation_currency text,
  total_income numeric,
  total_expense numeric,
  net_result numeric,
  total_assets numeric,
  total_liabilities numeric,
  total_equity numeric,
  translation_reserve numeric,
  balance_difference numeric,
  is_balanced boolean
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH l AS (
    SELECT * FROM public.get_consolidated_statement_lines(_group_id, _date_from, _date_to)
  ),
  agg AS (
    SELECT min(l.presentation_currency) AS presentation_currency,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'income'), 0)  AS total_income,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'expense'), 0) AS total_expense,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'asset'), 0)      AS total_assets,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'liability'), 0)  AS total_liabilities,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'equity'), 0)     AS total_equity,
           COALESCE(sum(l.amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.is_residual), 0)            AS translation_reserve
      FROM l
  )
  SELECT a.presentation_currency,
         a.total_income,
         a.total_expense,
         round(a.total_income - a.total_expense, 2),
         a.total_assets,
         a.total_liabilities,
         a.total_equity,
         a.translation_reserve,
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2),
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2) = 0
    FROM agg a;
$$;

COMMENT ON FUNCTION public.get_consolidated_statement_totals(uuid, date, date) IS
  'Group totals for the consolidated statements, including an explicit balance check. Derived only from get_consolidated_statement_lines.';

GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_lines(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_totals(uuid, date, date) TO authenticated;