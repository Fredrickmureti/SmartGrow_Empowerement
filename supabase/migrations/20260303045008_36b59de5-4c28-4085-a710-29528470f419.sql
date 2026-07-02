
-- ============================================================
-- ACCOUNTING FIX MIGRATION
-- 1. Drop 2 broken/duplicate balance triggers on journal_entries
-- 2. Fix get_account_balance_at_date (debit_amount → debit)
-- 3. Fix create_gl_entry_from_source (debit_amount → debit)
-- 4. Fix generate_pos_shift_journal_entry (debit_amount → debit)
-- 5. Drop line-level trigger (conflicts with posting trigger)
-- ============================================================

-- STEP 1: Drop broken duplicate triggers
DROP TRIGGER IF EXISTS trigger_handle_journal_entry_status_change ON public.journal_entries;
DROP TRIGGER IF EXISTS trigger_update_balances_on_entry_status ON public.journal_entries;

-- Also drop the line-level balance trigger — it conflicts with the posting trigger
-- (when a JE is inserted as 'posted' directly, both the line INSERT trigger and the
-- status-change trigger fire, causing double-counting)
DROP TRIGGER IF EXISTS trg_update_account_balance_on_je_line ON public.journal_entry_lines;

-- Drop the now-orphaned functions
DROP FUNCTION IF EXISTS public.handle_journal_entry_status_change();
DROP FUNCTION IF EXISTS public.update_account_balances_on_entry_status_change();
DROP FUNCTION IF EXISTS public.update_account_balance_on_je_line();

-- STEP 2: Fix get_account_balance_at_date
CREATE OR REPLACE FUNCTION public.get_account_balance_at_date(
  p_account_id UUID,
  p_as_of_date DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
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
        COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
      ELSE
        COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
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

-- STEP 3: Fix create_gl_entry_from_source
CREATE OR REPLACE FUNCTION public.create_gl_entry_from_source(
  p_organization_id UUID,
  p_business_id UUID,
  p_source_type TEXT,
  p_source_id UUID,
  p_entry_date DATE,
  p_reference TEXT,
  p_description TEXT,
  p_lines JSONB,
  p_auto_post BOOLEAN DEFAULT TRUE
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

  -- Validate debits = credits (accept both naming conventions from callers)
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::NUMERIC, (v_line->>'debit_amount')::NUMERIC, 0);
    v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::NUMERIC, (v_line->>'credit_amount')::NUMERIC, 0);
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

  -- Create journal entry lines using correct column names
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  SELECT 
    v_entry_id,
    (line->>'account_id')::UUID,
    COALESCE((line->>'debit')::NUMERIC, (line->>'debit_amount')::NUMERIC, 0),
    COALESCE((line->>'credit')::NUMERIC, (line->>'credit_amount')::NUMERIC, 0),
    COALESCE(line->>'description', p_description)
  FROM jsonb_array_elements(p_lines) AS line;

  RETURN v_entry_id;
END;
$$;

-- STEP 4: Fix generate_pos_shift_journal_entry
CREATE OR REPLACE FUNCTION public.generate_pos_shift_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_business_id UUID;
  v_journal_entry_id UUID;
  v_cash_account_id UUID;
  v_revenue_account_id UUID;
  v_tax_account_id UUID;
  v_total_sales NUMERIC := 0;
  v_total_tax NUMERIC := 0;
  v_total_net NUMERIC := 0;
  v_shift_date DATE;
  v_reference TEXT;
BEGIN
  -- Only fire when status changes to 'closed'
  IF NEW.status != 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  v_org_id := NEW.organization_id;
  v_business_id := NEW.business_id;
  v_shift_date := COALESCE(NEW.closed_at, NOW())::DATE;
  v_reference := 'POS-SHIFT-' || COALESCE(NEW.id::TEXT, 'unknown');

  -- Get totals from transactions in this shift
  SELECT 
    COALESCE(SUM(total), 0),
    COALESCE(SUM(tax_amount), 0),
    COALESCE(SUM(subtotal), 0)
  INTO v_total_sales, v_total_tax, v_total_net
  FROM pos_transactions
  WHERE shift_id = NEW.id
    AND transaction_type = 'sale'
    AND status = 'completed';

  -- Skip if no sales
  IF v_total_sales = 0 THEN
    RETURN NEW;
  END IF;

  -- Find default accounts
  SELECT id INTO v_cash_account_id
  FROM accounts
  WHERE organization_id = v_org_id
    AND account_type = 'asset'
    AND (LOWER(name) LIKE '%cash%' OR LOWER(code) LIKE '1001%')
    AND is_active = true
  LIMIT 1;

  SELECT id INTO v_revenue_account_id
  FROM accounts
  WHERE organization_id = v_org_id
    AND account_type = 'income'
    AND (LOWER(name) LIKE '%revenue%' OR LOWER(name) LIKE '%sales%' OR LOWER(code) LIKE '4001%')
    AND is_active = true
  LIMIT 1;

  SELECT id INTO v_tax_account_id
  FROM accounts
  WHERE organization_id = v_org_id
    AND account_type = 'liability'
    AND (LOWER(name) LIKE '%tax%' OR LOWER(code) LIKE '2200%')
    AND is_active = true
  LIMIT 1;

  -- If no accounts found, skip silently
  IF v_cash_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Create journal entry
  INSERT INTO journal_entries (
    organization_id, business_id, entry_date, reference, memo, 
    source_type, source_id, status, created_by
  ) VALUES (
    v_org_id, v_business_id, v_shift_date, v_reference,
    'POS Shift Close - Auto-generated journal entry',
    'pos_shift', NEW.id, 'posted', NEW.closed_by
  )
  RETURNING id INTO v_journal_entry_id;

  -- Debit Cash (FIXED: debit_amount → debit, credit_amount → credit)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_cash_account_id, v_total_sales, 0,
    'POS Cash/Card Receipts'
  );

  -- Credit Revenue (net of tax)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description
  ) VALUES (
    v_journal_entry_id, v_revenue_account_id, 0, v_total_net,
    'POS Sales Revenue'
  );

  -- Credit Tax Liability (if applicable)
  IF v_total_tax > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description
    ) VALUES (
      v_journal_entry_id, v_tax_account_id, 0, v_total_tax,
      'POS Sales Tax Collected'
    );
  END IF;

  -- Link journal entry to shift
  NEW.journal_entry_id := v_journal_entry_id;

  RETURN NEW;
END;
$$;
