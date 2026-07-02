
ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS total_sales numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_returns numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_transactions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_payments numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_payments numeric NOT NULL DEFAULT 0;
