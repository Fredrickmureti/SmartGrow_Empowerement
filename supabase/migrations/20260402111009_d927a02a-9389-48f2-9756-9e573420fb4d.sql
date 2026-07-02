
-- Phase 1: Add trigger on journal_entries for status changes
-- This fixes two critical bugs:
-- 1. Voided JEs never reversed current_balance
-- 2. Draft→Posted status changes never updated current_balance

CREATE OR REPLACE FUNCTION public.sync_balances_on_je_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- posted → voided: reverse all line impacts from current_balance
  IF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance - (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  -- draft → posted: apply all existing line balances to current_balance
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    UPDATE accounts a
    SET current_balance = a.current_balance + (
      CASE WHEN a.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ),
    updated_at = now()
    FROM journal_entry_lines jel
    WHERE jel.journal_entry_id = NEW.id
      AND a.id = jel.account_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Create the trigger
DROP TRIGGER IF EXISTS trg_sync_balances_on_je_status ON journal_entries;
CREATE TRIGGER trg_sync_balances_on_je_status
  AFTER UPDATE ON journal_entries
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_balances_on_je_status_change();

-- ============================================================
-- Reconcile ALL current_balance values from posted JE lines
-- This fixes any historical drift from the missing triggers
-- ============================================================

-- Step 1: Recalculate balances for accounts that have posted JE lines
UPDATE accounts a
SET current_balance = COALESCE(calc.balance, 0),
    updated_at = now()
FROM (
  SELECT jel.account_id,
    SUM(
      CASE WHEN acct.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ) AS balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN accounts acct ON acct.id = jel.account_id
  WHERE je.status = 'posted'
  GROUP BY jel.account_id
) calc
WHERE a.id = calc.account_id;

-- Step 2: Zero out accounts that have no posted JE lines but have non-zero balance
UPDATE accounts
SET current_balance = 0, updated_at = now()
WHERE id NOT IN (
  SELECT DISTINCT jel.account_id
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
)
AND current_balance != 0;
