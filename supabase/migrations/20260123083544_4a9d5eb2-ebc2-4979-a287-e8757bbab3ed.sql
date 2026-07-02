-- Fix: Change locked_by FK to reference auth.users instead of profiles
-- This is more reliable since profiles table may not be populated for all users

-- Drop the existing foreign key constraint
ALTER TABLE public.fiscal_periods
DROP CONSTRAINT IF EXISTS fiscal_periods_locked_by_fkey;

-- Add new foreign key referencing auth.users
ALTER TABLE public.fiscal_periods
ADD CONSTRAINT fiscal_periods_locked_by_fkey 
FOREIGN KEY (locked_by) REFERENCES auth.users(id) ON DELETE SET NULL;