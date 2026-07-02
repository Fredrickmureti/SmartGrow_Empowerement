ALTER TABLE public.tax_rates
  ADD COLUMN IF NOT EXISTS tax_type text NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS fixed_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT '1900-01-01',
  ADD COLUMN IF NOT EXISTS effective_to date;