-- =====================================================
-- PHASE 1.1: Account Balance Update Triggers
-- =====================================================
-- This trigger automatically updates the current_balance
-- on accounts whenever journal entry lines are inserted,
-- updated, or deleted AND the journal entry is posted.
-- =====================================================

-- Function to update account balances based on journal entry lines
CREATE OR REPLACE FUNCTION public.update_account_balance_on_journal_line()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_status TEXT;
  v_account_type TEXT;
  v_balance_change NUMERIC;
BEGIN
  -- For INSERT or UPDATE, check if the journal entry is posted
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    SELECT status INTO v_entry_status 
    FROM journal_entries 
    WHERE id = NEW.journal_entry_id;
    
    -- Only update balances for posted entries
    IF v_entry_status = 'posted' THEN
      -- Get account type to determine how to calculate balance
      SELECT account_type INTO v_account_type 
      FROM accounts 
      WHERE id = NEW.account_id;
      
      -- Calculate balance change based on account type
      -- Assets and Expenses: Debit increases, Credit decreases
      -- Liabilities, Equity, Income: Credit increases, Debit decreases
      IF v_account_type IN ('asset', 'expense') THEN
        v_balance_change := COALESCE(NEW.debit_amount, 0) - COALESCE(NEW.credit_amount, 0);
      ELSE
        v_balance_change := COALESCE(NEW.credit_amount, 0) - COALESCE(NEW.debit_amount, 0);
      END IF;
      
      -- If this is an UPDATE, we need to reverse the old values first
      IF TG_OP = 'UPDATE' AND OLD.account_id IS NOT NULL THEN
        -- Get old account type
        SELECT account_type INTO v_account_type 
        FROM accounts 
        WHERE id = OLD.account_id;
        
        IF v_account_type IN ('asset', 'expense') THEN
          UPDATE accounts 
          SET current_balance = COALESCE(current_balance, 0) - (COALESCE(OLD.debit_amount, 0) - COALESCE(OLD.credit_amount, 0)),
              updated_at = NOW()
          WHERE id = OLD.account_id;
        ELSE
          UPDATE accounts 
          SET current_balance = COALESCE(current_balance, 0) - (COALESCE(OLD.credit_amount, 0) - COALESCE(OLD.debit_amount, 0)),
              updated_at = NOW()
          WHERE id = OLD.account_id;
        END IF;
      END IF;
      
      -- Apply the new balance change
      UPDATE accounts 
      SET current_balance = COALESCE(current_balance, 0) + v_balance_change,
          updated_at = NOW()
      WHERE id = NEW.account_id;
    END IF;
    
    RETURN NEW;
  END IF;
  
  -- For DELETE, reverse the balance if entry was posted
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_entry_status 
    FROM journal_entries 
    WHERE id = OLD.journal_entry_id;
    
    IF v_entry_status = 'posted' THEN
      SELECT account_type INTO v_account_type 
      FROM accounts 
      WHERE id = OLD.account_id;
      
      IF v_account_type IN ('asset', 'expense') THEN
        v_balance_change := COALESCE(OLD.debit_amount, 0) - COALESCE(OLD.credit_amount, 0);
      ELSE
        v_balance_change := COALESCE(OLD.credit_amount, 0) - COALESCE(OLD.debit_amount, 0);
      END IF;
      
      UPDATE accounts 
      SET current_balance = COALESCE(current_balance, 0) - v_balance_change,
          updated_at = NOW()
      WHERE id = OLD.account_id;
    END IF;
    
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function to handle journal entry status changes (draft -> posted, posted -> voided)
CREATE OR REPLACE FUNCTION public.update_account_balances_on_entry_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_line RECORD;
  v_account_type TEXT;
  v_balance_change NUMERIC;
BEGIN
  -- When status changes from draft to posted, add all line amounts to accounts
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    FOR v_line IN 
      SELECT * FROM journal_entry_lines WHERE journal_entry_id = NEW.id
    LOOP
      SELECT account_type INTO v_account_type 
      FROM accounts 
      WHERE id = v_line.account_id;
      
      IF v_account_type IN ('asset', 'expense') THEN
        v_balance_change := COALESCE(v_line.debit_amount, 0) - COALESCE(v_line.credit_amount, 0);
      ELSE
        v_balance_change := COALESCE(v_line.credit_amount, 0) - COALESCE(v_line.debit_amount, 0);
      END IF;
      
      UPDATE accounts 
      SET current_balance = COALESCE(current_balance, 0) + v_balance_change,
          updated_at = NOW()
      WHERE id = v_line.account_id;
    END LOOP;
  END IF;
  
  -- When status changes from posted to voided, reverse all line amounts
  IF OLD.status = 'posted' AND NEW.status = 'voided' THEN
    FOR v_line IN 
      SELECT * FROM journal_entry_lines WHERE journal_entry_id = NEW.id
    LOOP
      SELECT account_type INTO v_account_type 
      FROM accounts 
      WHERE id = v_line.account_id;
      
      IF v_account_type IN ('asset', 'expense') THEN
        v_balance_change := COALESCE(v_line.debit_amount, 0) - COALESCE(v_line.credit_amount, 0);
      ELSE
        v_balance_change := COALESCE(v_line.credit_amount, 0) - COALESCE(v_line.debit_amount, 0);
      END IF;
      
      UPDATE accounts 
      SET current_balance = COALESCE(current_balance, 0) - v_balance_change,
          updated_at = NOW()
      WHERE id = v_line.account_id;
    END LOOP;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trigger_update_account_balance_on_line ON journal_entry_lines;
DROP TRIGGER IF EXISTS trigger_update_balances_on_entry_status ON journal_entries;

-- Create trigger on journal_entry_lines for INSERT/UPDATE/DELETE
CREATE TRIGGER trigger_update_account_balance_on_line
AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
FOR EACH ROW
EXECUTE FUNCTION update_account_balance_on_journal_line();

-- Create trigger on journal_entries for status changes
CREATE TRIGGER trigger_update_balances_on_entry_status
AFTER UPDATE OF status ON journal_entries
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION update_account_balances_on_entry_status_change();

-- =====================================================
-- PHASE 1.2: Fiscal Period Enforcement
-- =====================================================
-- This trigger prevents journal entries from being
-- posted to closed fiscal periods.
-- =====================================================

CREATE OR REPLACE FUNCTION public.validate_fiscal_period_for_journal_entry()
RETURNS TRIGGER AS $$
DECLARE
  v_closed_period RECORD;
BEGIN
  -- Only check when posting (status changing to 'posted')
  IF NEW.status = 'posted' THEN
    -- Check if the entry date falls within any closed period for this organization
    SELECT id, name INTO v_closed_period
    FROM fiscal_periods
    WHERE organization_id = NEW.organization_id
      AND status = 'closed'
      AND NEW.entry_date >= start_date
      AND NEW.entry_date <= end_date
    LIMIT 1;
    
    IF FOUND THEN
      RAISE EXCEPTION 'Cannot post journal entry to closed fiscal period: %', v_closed_period.name;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_validate_fiscal_period ON journal_entries;

-- Create trigger to validate fiscal period before insert/update
CREATE TRIGGER trigger_validate_fiscal_period
BEFORE INSERT OR UPDATE ON journal_entries
FOR EACH ROW
EXECUTE FUNCTION validate_fiscal_period_for_journal_entry();