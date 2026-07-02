-- =============================================================
-- Fix #1: Replace the current_balance trigger with account-type-aware sign logic
-- Fix #2: Drop conflicting old triggers
-- Fix #3: Reconcile all existing account balances from journal entry lines
-- =============================================================

-- Drop ALL existing balance-update triggers on journal_entry_lines to eliminate conflicts
DROP TRIGGER IF EXISTS trg_update_account_balance_on_je_line ON public.journal_entry_lines;
DROP TRIGGER IF EXISTS update_account_balance_trigger ON public.journal_entry_lines;
DROP TRIGGER IF EXISTS trg_update_account_balances_on_je_post ON public.journal_entries;

-- Drop old functions
DROP FUNCTION IF EXISTS public.update_account_balance_on_je_line() CASCADE;
DROP FUNCTION IF EXISTS public.update_account_balance() CASCADE;
DROP FUNCTION IF EXISTS public.update_account_balances_on_je_post() CASCADE;

-- Create the SINGLE correct trigger function for account balance updates
CREATE OR REPLACE FUNCTION public.update_account_balance_on_je_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _account_type text;
  _je_status text;
  _debit numeric;
  _credit numeric;
BEGIN
  -- Only process if the parent journal entry is posted
  SELECT status INTO _je_status
  FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF _je_status IS DISTINCT FROM 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Get account type for sign logic
  SELECT account_type::text INTO _account_type
  FROM public.accounts
  WHERE id = COALESCE(NEW.account_id, OLD.account_id);

  IF TG_OP = 'INSERT' THEN
    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);

    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit
        ELSE _credit - _debit
      END,
      updated_at = now()
    WHERE id = NEW.account_id;

    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);

    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit
        ELSE _credit - _debit
      END,
      updated_at = now()
    WHERE id = OLD.account_id;

    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Reverse old values
    _debit := COALESCE(OLD.debit, 0);
    _credit := COALESCE(OLD.credit, 0);

    UPDATE public.accounts
    SET current_balance = current_balance -
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit
        ELSE _credit - _debit
      END
    WHERE id = OLD.account_id;

    -- Apply new values
    _debit := COALESCE(NEW.debit, 0);
    _credit := COALESCE(NEW.credit, 0);

    SELECT account_type::text INTO _account_type
    FROM public.accounts
    WHERE id = NEW.account_id;

    UPDATE public.accounts
    SET current_balance = current_balance +
      CASE WHEN _account_type IN ('asset', 'expense')
        THEN _debit - _credit
        ELSE _credit - _debit
      END,
      updated_at = now()
    WHERE id = NEW.account_id;

    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

-- Create the single trigger
CREATE TRIGGER trg_update_account_balance_on_je_line
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.update_account_balance_on_je_line();

-- =============================================================
-- Reconcile ALL existing account current_balance values
-- Recalculate from posted journal entry lines
-- =============================================================
UPDATE public.accounts a
SET current_balance = COALESCE(calc.balance, 0),
    updated_at = now()
FROM (
  SELECT
    jel.account_id,
    SUM(
      CASE WHEN acct.account_type IN ('asset', 'expense')
        THEN COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0)
        ELSE COALESCE(jel.credit, 0) - COALESCE(jel.debit, 0)
      END
    ) AS balance
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.accounts acct ON acct.id = jel.account_id
  WHERE je.status = 'posted'
  GROUP BY jel.account_id
) calc
WHERE a.id = calc.account_id;

-- Zero out accounts that have no posted journal entry lines
UPDATE public.accounts
SET current_balance = 0, updated_at = now()
WHERE id NOT IN (
  SELECT DISTINCT jel.account_id
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.status = 'posted'
)
AND current_balance != 0;