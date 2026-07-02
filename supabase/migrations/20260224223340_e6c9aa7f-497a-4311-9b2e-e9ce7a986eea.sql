
-- 1. Add 'source' column to invoices table
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- 2. Update existing POS invoices based on notes prefix
UPDATE public.invoices SET source = 'pos' WHERE notes ILIKE '[POS]%' AND (source IS NULL OR source = 'manual');

-- 3. Fix generate_pos_shift_journal_entry() — replace 'revenue' with 'income'
CREATE OR REPLACE FUNCTION public.generate_pos_shift_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
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

  -- Debit Cash
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit_amount, credit_amount, description
  ) VALUES (
    v_journal_entry_id, v_cash_account_id, v_total_sales, 0,
    'POS Cash/Card Receipts'
  );

  -- Credit Revenue (net of tax)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit_amount, credit_amount, description
  ) VALUES (
    v_journal_entry_id, v_revenue_account_id, 0, v_total_net,
    'POS Sales Revenue'
  );

  -- Credit Tax Liability (if applicable)
  IF v_total_tax > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit_amount, credit_amount, description
    ) VALUES (
      v_journal_entry_id, v_tax_account_id, 0, v_total_tax,
      'POS Sales Tax Collected'
    );
  END IF;

  -- Link journal entry to shift
  NEW.journal_entry_id := v_journal_entry_id;

  RETURN NEW;
END;
$function$;
