ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS day_control_from date,
  ADD COLUMN IF NOT EXISTS day_variance_tolerance numeric(18,2) NOT NULL DEFAULT 0;