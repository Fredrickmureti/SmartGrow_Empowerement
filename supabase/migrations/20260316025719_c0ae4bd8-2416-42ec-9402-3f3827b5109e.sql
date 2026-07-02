
-- Task 1: Add missing columns to bank_accounts for proper manual banking
ALTER TABLE public.bank_accounts 
  ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(15,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_balance_date DATE,
  ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'checking';

-- Enable manual provider by default (data fix)
UPDATE public.platform_bank_providers 
SET is_enabled = true 
WHERE provider_code = 'manual';

-- Add RLS policy so ALL authenticated users can see manual provider regardless of is_enabled
-- First drop existing policy if it exists, then create new one
DO $$
BEGIN
  -- Check if policy exists before trying to drop
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'platform_bank_providers' 
    AND policyname = 'Manual provider always visible'
  ) THEN
    DROP POLICY "Manual provider always visible" ON public.platform_bank_providers;
  END IF;
END $$;

CREATE POLICY "Manual provider always visible"
  ON public.platform_bank_providers
  FOR SELECT
  TO authenticated
  USING (provider_code = 'manual');
