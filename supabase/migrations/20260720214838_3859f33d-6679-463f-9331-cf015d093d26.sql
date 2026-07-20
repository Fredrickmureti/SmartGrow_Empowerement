ALTER TABLE public.printer_profiles
  ADD COLUMN IF NOT EXISTS is_calibrated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.printer_profiles.is_calibrated IS
  'True only after a physical test confirms this profile font and columns_override fit the configured paper width.';

UPDATE public.printer_profiles
SET is_calibrated = false
WHERE is_calibrated IS DISTINCT FROM false;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.printer_profiles TO authenticated;
GRANT ALL ON public.printer_profiles TO service_role;