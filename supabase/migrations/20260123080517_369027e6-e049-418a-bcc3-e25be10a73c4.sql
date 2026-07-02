-- =====================================================
-- PHASE 1B: GL AUTO-POSTING FUNCTIONS & TRIGGERS
-- =====================================================

-- 1. Function to update account balances when journal entries are posted
CREATE OR REPLACE FUNCTION public.update_account_balance_from_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry_status TEXT;
BEGIN
  -- Get the journal entry status
  SELECT status INTO entry_status
  FROM journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  -- Only update balances for posted entries
  IF entry_status = 'posted' THEN
    IF TG_OP = 'INSERT' THEN
      -- Add to account balance
      UPDATE accounts
      SET current_balance = COALESCE(current_balance, 0) + 
        CASE 
          -- Assets and Expenses: debit increases, credit decreases
          WHEN account_type IN ('asset', 'expense') THEN NEW.debit_amount - NEW.credit_amount
          -- Liabilities, Equity, Income: credit increases, debit decreases
          ELSE NEW.credit_amount - NEW.debit_amount
        END,
        updated_at = now()
      WHERE id = NEW.account_id;
      
    ELSIF TG_OP = 'DELETE' THEN
      -- Reverse the balance change
      UPDATE accounts
      SET current_balance = COALESCE(current_balance, 0) - 
        CASE 
          WHEN account_type IN ('asset', 'expense') THEN OLD.debit_amount - OLD.credit_amount
          ELSE OLD.credit_amount - OLD.debit_amount
        END,
        updated_at = now()
      WHERE id = OLD.account_id;
      
    ELSIF TG_OP = 'UPDATE' THEN
      -- Reverse old and apply new
      UPDATE accounts
      SET current_balance = COALESCE(current_balance, 0) 
        - CASE WHEN account_type IN ('asset', 'expense') THEN OLD.debit_amount - OLD.credit_amount ELSE OLD.credit_amount - OLD.debit_amount END
        + CASE WHEN account_type IN ('asset', 'expense') THEN NEW.debit_amount - NEW.credit_amount ELSE NEW.credit_amount - NEW.debit_amount END,
        updated_at = now()
      WHERE id = NEW.account_id;
    END IF;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 2. Function to handle journal entry status changes
CREATE OR REPLACE FUNCTION public.handle_journal_entry_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- When posting a journal entry, update all account balances
  IF NEW.status = 'posted' AND OLD.status != 'posted' THEN
    UPDATE accounts a
    SET current_balance = COALESCE(a.current_balance, 0) + (
      SELECT CASE 
        WHEN a.account_type IN ('asset', 'expense') THEN COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0)
        ELSE COALESCE(SUM(jel.credit_amount), 0) - COALESCE(SUM(jel.debit_amount), 0)
      END
      FROM journal_entry_lines jel
      WHERE jel.journal_entry_id = NEW.id AND jel.account_id = a.id
    ),
    updated_at = now()
    WHERE a.id IN (SELECT account_id FROM journal_entry_lines WHERE journal_entry_id = NEW.id);
    
  -- When voiding a posted entry, reverse the balances
  ELSIF NEW.status = 'void' AND OLD.status = 'posted' THEN
    UPDATE accounts a
    SET current_balance = COALESCE(a.current_balance, 0) - (
      SELECT CASE 
        WHEN a.account_type IN ('asset', 'expense') THEN COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0)
        ELSE COALESCE(SUM(jel.credit_amount), 0) - COALESCE(SUM(jel.debit_amount), 0)
      END
      FROM journal_entry_lines jel
      WHERE jel.journal_entry_id = NEW.id AND jel.account_id = a.id
    ),
    updated_at = now()
    WHERE a.id IN (SELECT account_id FROM journal_entry_lines WHERE journal_entry_id = NEW.id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- 3. Create triggers
CREATE TRIGGER trigger_update_account_balance_from_journal
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_account_balance_from_journal();

CREATE TRIGGER trigger_handle_journal_entry_status_change
  AFTER UPDATE ON public.journal_entries
  FOR EACH ROW 
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.handle_journal_entry_status_change();

-- 4. Function to create journal entry from source document
CREATE OR REPLACE FUNCTION public.create_gl_entry_from_source(
  p_organization_id UUID,
  p_business_id UUID,
  p_source_type TEXT,
  p_source_id UUID,
  p_reference TEXT,
  p_description TEXT,
  p_entry_date DATE,
  p_lines JSONB,  -- Array of {account_id, debit_amount, credit_amount, description}
  p_auto_post BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id UUID;
  v_entry_number TEXT;
  v_line JSONB;
  v_total_debit NUMERIC := 0;
  v_total_credit NUMERIC := 0;
BEGIN
  -- Generate entry number
  SELECT COALESCE('JE-' || LPAD((MAX(CAST(SUBSTRING(entry_number FROM 4) AS INTEGER)) + 1)::TEXT, 6, '0'), 'JE-000001')
  INTO v_entry_number
  FROM journal_entries
  WHERE organization_id = p_organization_id;

  -- Validate debits = credits
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit_amount')::NUMERIC, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit_amount')::NUMERIC, 0);
  END LOOP;

  IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry does not balance: debits=%, credits=%', v_total_debit, v_total_credit;
  END IF;

  -- Create journal entry
  INSERT INTO journal_entries (
    organization_id, business_id, entry_number, entry_date, 
    reference, description, status, source_type, source_id,
    created_by
  ) VALUES (
    p_organization_id, p_business_id, v_entry_number, p_entry_date,
    p_reference, p_description, 
    CASE WHEN p_auto_post THEN 'posted' ELSE 'draft' END,
    p_source_type, p_source_id,
    auth.uid()
  )
  RETURNING id INTO v_entry_id;

  -- Create journal entry lines
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
  SELECT 
    v_entry_id,
    (line->>'account_id')::UUID,
    COALESCE((line->>'debit_amount')::NUMERIC, 0),
    COALESCE((line->>'credit_amount')::NUMERIC, 0),
    COALESCE(line->>'description', p_description)
  FROM jsonb_array_elements(p_lines) AS line;

  RETURN v_entry_id;
END;
$$;

-- 5. Function to check if a date is in a locked period
CREATE OR REPLACE FUNCTION public.is_period_locked(
  p_organization_id UUID,
  p_business_id UUID,
  p_date DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM fiscal_periods
    WHERE organization_id = p_organization_id
    AND (business_id = p_business_id OR business_id IS NULL)
    AND p_date BETWEEN start_date AND end_date
    AND status = 'closed'
  );
END;
$$;

-- 6. Function to get account balance at a specific date
CREATE OR REPLACE FUNCTION public.get_account_balance_at_date(
  p_account_id UUID,
  p_as_of_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance NUMERIC;
  v_account_type TEXT;
BEGIN
  SELECT account_type INTO v_account_type FROM accounts WHERE id = p_account_id;
  
  SELECT 
    COALESCE(a.opening_balance, 0) +
    CASE 
      WHEN v_account_type IN ('asset', 'expense') THEN
        COALESCE(SUM(jel.debit_amount), 0) - COALESCE(SUM(jel.credit_amount), 0)
      ELSE
        COALESCE(SUM(jel.credit_amount), 0) - COALESCE(SUM(jel.debit_amount), 0)
    END
  INTO v_balance
  FROM accounts a
  LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
  LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
    AND je.status = 'posted'
    AND je.entry_date <= p_as_of_date
  WHERE a.id = p_account_id
  GROUP BY a.id, a.opening_balance;
  
  RETURN COALESCE(v_balance, 0);
END;
$$;