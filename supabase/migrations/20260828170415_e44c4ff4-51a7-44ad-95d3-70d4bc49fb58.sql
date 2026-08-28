DROP FUNCTION IF EXISTS public.get_consolidated_statement_lines_eliminated(uuid, date, date);

CREATE FUNCTION public.get_consolidated_statement_lines_eliminated(_group_id uuid, _date_from date, _date_to date)
 RETURNS TABLE(statement text, section text, section_order integer, account_id uuid, account_code text, account_name text, account_type account_type, is_residual boolean, is_derived boolean, presentation_currency text, aggregated_amount numeric, elimination_amount numeric, consolidated_amount numeric, reconciling_amount numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT * FROM public.get_consolidated_statement_lines(_group_id, _date_from, _date_to)
  ),
  elim AS (
    SELECT e.group_account_id,
           e.account_type,
           round(sum(CASE WHEN e.account_type IN ('asset', 'expense')
                          THEN e.debit - e.credit ELSE e.credit - e.debit END), 2) AS amount,
           round(sum(CASE WHEN NOT e.is_difference THEN 0
                          WHEN e.account_type IN ('asset', 'expense')
                          THEN e.debit - e.credit ELSE e.credit - e.debit END), 2) AS difference_amount
      FROM public.consolidation_eliminations e
     WHERE e.group_id = _group_id AND e.period_start = _date_from AND e.period_end = _date_to
     GROUP BY e.group_account_id, e.account_type
  ),
  result_effect AS (
    SELECT COALESCE(round(sum(CASE WHEN el.account_type = 'income' THEN el.amount
                                   WHEN el.account_type = 'expense' THEN -el.amount
                                   ELSE 0 END), 2), 0) AS amount,
           COALESCE(round(sum(CASE WHEN el.account_type = 'income' THEN el.difference_amount
                                   WHEN el.account_type = 'expense' THEN -el.difference_amount
                                   ELSE 0 END), 2), 0) AS difference_amount
      FROM elim el
  ),
  joined AS (
    SELECT b.statement, b.section, b.section_order, b.account_id, b.account_code,
           b.account_name, b.account_type, b.is_residual, b.is_derived,
           b.presentation_currency,
           b.amount AS aggregated_amount,
           CASE
             WHEN b.is_derived AND b.statement = 'balance_sheet'
               THEN (SELECT amount FROM result_effect)
             WHEN b.is_derived THEN 0
             ELSE COALESCE(el.amount, 0)
           END AS elimination_amount,
           CASE
             WHEN b.is_derived AND b.statement = 'balance_sheet'
               THEN (SELECT difference_amount FROM result_effect)
             WHEN b.is_derived THEN 0
             ELSE COALESCE(el.difference_amount, 0)
           END AS reconciling_amount
      FROM base b
      LEFT JOIN elim el ON el.group_account_id = b.account_id AND el.account_type = b.account_type

    UNION ALL

    SELECT CASE WHEN el.account_type IN ('income', 'expense') THEN 'income_statement' ELSE 'balance_sheet' END,
           CASE WHEN el.account_type = 'income' THEN 'income'
                WHEN el.account_type = 'expense' THEN 'expense'
                ELSE el.account_type::text END,
           CASE el.account_type WHEN 'income' THEN 1 WHEN 'expense' THEN 2
                                WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END,
           el.group_account_id, COALESCE(a.code, ac.code), COALESCE(a.name, ac.name),
           el.account_type, (a.id IS NULL), false,
           (SELECT g.presentation_currency FROM public.consolidation_groups g WHERE g.id = _group_id),
           0, el.amount, el.difference_amount
      FROM elim el
      LEFT JOIN public.consolidation_group_accounts a ON a.id = el.group_account_id
      LEFT JOIN public.accounts ac ON ac.id = el.group_account_id
     WHERE COALESCE(a.name, ac.name) IS NOT NULL
       AND NOT EXISTS (
       SELECT 1 FROM base b
        WHERE b.account_id = el.group_account_id AND b.account_type = el.account_type
     )
  )
  SELECT j.statement, j.section, j.section_order, j.account_id, j.account_code,
         j.account_name, j.account_type, j.is_residual, j.is_derived,
         j.presentation_currency, j.aggregated_amount, j.elimination_amount,
         round(j.aggregated_amount + j.elimination_amount, 2),
         round(j.reconciling_amount, 2)
    FROM joined j
   WHERE round(j.aggregated_amount, 2) <> 0 OR round(j.elimination_amount, 2) <> 0
   ORDER BY j.statement, j.section_order, j.is_derived, j.account_code NULLS LAST, j.account_name;
$function$;

REVOKE ALL ON FUNCTION public.get_consolidated_statement_lines_eliminated(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_consolidated_statement_lines_eliminated(uuid, date, date) TO authenticated, service_role;