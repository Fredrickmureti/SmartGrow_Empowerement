-- Add preferred_currency column to profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferred_currency TEXT;

-- Add comment for documentation
COMMENT ON COLUMN public.profiles.preferred_currency IS 'User preferred display currency. Falls back to organization base_currency if null.';