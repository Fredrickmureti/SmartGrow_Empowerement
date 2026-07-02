-- Phase 2: scope printer profile column overrides by paper width.
-- A printer profile carries hardware-specific corrections (real column count,
-- physical margins) that are only valid for a specific paper width. Without
-- recording the paper the profile was tuned for, switching paper_size on a
-- terminal silently inherits an 80mm-tuned override on 58mm paper → overflow.
ALTER TABLE public.printer_profiles
  ADD COLUMN IF NOT EXISTS paper_size text
    CHECK (paper_size IS NULL OR paper_size IN ('40mm','58mm','80mm'));

COMMENT ON COLUMN public.printer_profiles.paper_size IS
  'Paper width this profile''s columns_override / margin_cols were measured for. '
  'When set, generate-document drops the override if the resolved receipt paper differs.';