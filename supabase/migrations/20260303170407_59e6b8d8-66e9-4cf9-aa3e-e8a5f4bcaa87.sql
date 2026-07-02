
-- Fix 3: Correct misclassified account types based on code ranges
-- Only fix accounts where the code prefix clearly indicates a different type

-- Fix org 0194f7de accounts
UPDATE public.accounts SET account_type = 'liability' WHERE code = '2000' AND name = 'Liabilities' AND account_type = 'asset';
UPDATE public.accounts SET account_type = 'equity' WHERE code = '3000' AND name = 'Equity' AND account_type = 'asset';
UPDATE public.accounts SET account_type = 'income' WHERE code = '4000' AND name = 'Income' AND account_type = 'asset';
UPDATE public.accounts SET account_type = 'expense' WHERE code = '5000' AND name = 'Expenses' AND account_type = 'asset';

-- Fix org 2f19e46c: code 3000 is "Income" typed as income (correct name, wrong code — leave as-is since the name says Income)
-- Fix org 2f19e46c: code 4000 is "Expense" typed as expense (correct name, wrong code — leave as-is)

-- Broader sweep: fix any remaining parent-level accounts with standard code prefixes
-- that are clearly misclassified (only top-level codes like 2000, 3000, 4000, 5000)
UPDATE public.accounts 
SET account_type = 'liability' 
WHERE code LIKE '2___' AND account_type != 'liability' 
  AND code NOT LIKE '2____%'
  AND name ILIKE '%liabilit%';

UPDATE public.accounts 
SET account_type = 'equity' 
WHERE code LIKE '3___' AND account_type != 'equity' 
  AND code NOT LIKE '3____%'
  AND name ILIKE '%equity%';

UPDATE public.accounts 
SET account_type = 'income' 
WHERE code LIKE '4___' AND account_type != 'income' 
  AND code NOT LIKE '4____%'
  AND (name ILIKE '%income%' OR name ILIKE '%revenue%' OR name ILIKE '%sales%');

UPDATE public.accounts 
SET account_type = 'expense' 
WHERE code LIKE '5___' AND account_type != 'expense' 
  AND code NOT LIKE '5____%'
  AND (name ILIKE '%expense%' OR name ILIKE '%cost%');

-- Add a validation trigger to warn/prevent future misclassification
CREATE OR REPLACE FUNCTION public.validate_account_type_code_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  expected_type text;
  code_prefix text;
BEGIN
  code_prefix := substring(NEW.code from 1 for 1);
  
  CASE code_prefix
    WHEN '1' THEN expected_type := 'asset';
    WHEN '2' THEN expected_type := 'liability';
    WHEN '3' THEN expected_type := 'equity';
    WHEN '4' THEN expected_type := 'income';
    WHEN '5' THEN expected_type := 'expense';
    ELSE expected_type := NULL; -- non-standard codes, skip validation
  END CASE;
  
  -- If there's an expected type and it doesn't match, raise a warning but allow
  -- (Some orgs may use non-standard code ranges intentionally)
  IF expected_type IS NOT NULL AND NEW.account_type::text != expected_type THEN
    RAISE WARNING 'Account code % suggests type "%" but account_type is set to "%". This may cause incorrect financial reports.',
      NEW.code, expected_type, NEW.account_type;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_account_type_code ON public.accounts;
CREATE TRIGGER trg_validate_account_type_code
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_account_type_code_consistency();
