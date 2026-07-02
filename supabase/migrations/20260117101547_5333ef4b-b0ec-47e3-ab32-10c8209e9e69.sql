-- Make user_id nullable in pos_cashiers to support standalone cashiers
-- Standalone cashiers are those without a linked user account (e.g., quick-hire retail staff)
ALTER TABLE public.pos_cashiers ALTER COLUMN user_id DROP NOT NULL;

-- Add a comment to explain the nullable user_id
COMMENT ON COLUMN public.pos_cashiers.user_id IS 'Optional link to user account. NULL for standalone cashiers who only need terminal access via PIN.';

-- Update RLS policies to handle nullable user_id
-- Drop and recreate the policies to ensure they work with nullable user_id

-- The existing policies should work fine since they use organization_id for access control
-- But let's add a check constraint to ensure data integrity
ALTER TABLE public.pos_cashiers 
ADD CONSTRAINT pos_cashiers_valid_identity 
CHECK (display_name IS NOT NULL AND LENGTH(TRIM(display_name)) > 0);