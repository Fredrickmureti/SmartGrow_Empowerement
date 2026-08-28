DROP FUNCTION IF EXISTS public.get_consolidated_statement_totals_eliminated(uuid, date, date);

CREATE OR REPLACE FUNCTION public.get_consolidated_statement_totals_eliminated(_group_id uuid, _date_from date, _date_to date)
 RETURNS TABLE(presentation_currency text, total_income numeric, total_expense numeric, net_result numeric, total_assets numeric, total_liabilities numeric, total_equity numeric, translation_reserve numeric, eliminations_debit numeric, eliminations_credit numeric, balance_sheet_difference numeric, is_balanced boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH l AS (
    SELECT * FROM public.get_consolidated_statement_lines_eliminated(_group_id, _date_from, _date_to)
  ),
  e AS (
    SELECT COALESCE(sum(x.debit), 0) AS dr, COALESCE(sum(x.credit), 0) AS cr
      FROM public.consolidation_eliminations x
     WHERE x.group_id = _group_id AND x.period_start = _date_from AND x.period_end = _date_to
  ),
  agg AS (
    SELECT min(l.presentation_currency) AS presentation_currency,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'income'), 0) AS total_income,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'income_statement' AND l.section = 'expense'), 0) AS total_expense,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'asset'), 0) AS total_assets,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'liability'), 0) AS total_liabilities,
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.section = 'equity'), 0) AS total_equity,
           -- The reserve is disclosed from the SAME projection as the lines and
           -- the totals. Footing it in the browser instead would let the
           -- disclosure drift from the equity total it sits inside.
           COALESCE(sum(l.consolidated_amount) FILTER (WHERE l.statement = 'balance_sheet' AND l.is_residual), 0) AS translation_reserve
      FROM l
  )
  SELECT a.presentation_currency, a.total_income, a.total_expense,
         round(a.total_income - a.total_expense, 2),
         a.total_assets, a.total_liabilities, a.total_equity,
         round(a.translation_reserve, 2),
         e.dr, e.cr,
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2),
         round(a.total_assets - (a.total_liabilities + a.total_equity), 2) = 0
    FROM agg a CROSS JOIN e;
$function$;