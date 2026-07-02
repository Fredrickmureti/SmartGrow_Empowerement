
-- Priority 1: Drop the duplicate trigger and function
DROP TRIGGER IF EXISTS trg_update_account_balance ON public.journal_entry_lines;
DROP FUNCTION IF EXISTS public.update_account_current_balance();

-- Priority 2: Recalculate all current_balance from posted JE lines
UPDATE accounts a
SET current_balance = COALESCE(calc.balance, 0)
FROM (
  SELECT jel.account_id,
    SUM(CASE WHEN acct.account_type IN ('asset','expense')
      THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
      ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
    END) AS balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN accounts acct ON acct.id = jel.account_id
  WHERE je.status = 'posted'
  GROUP BY jel.account_id
) calc
WHERE a.id = calc.account_id;

-- Zero accounts with no posted lines
UPDATE accounts SET current_balance = 0
WHERE id NOT IN (
  SELECT DISTINCT jel.account_id FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
) AND current_balance != 0;
