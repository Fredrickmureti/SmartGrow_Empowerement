-- Add session_type column to pos_sessions for distinguishing cashier vs manager sessions
ALTER TABLE public.pos_sessions 
ADD COLUMN IF NOT EXISTS session_type VARCHAR(20) DEFAULT 'cashier';

-- Make cashier_id nullable to allow manager sessions without a cashier
ALTER TABLE public.pos_sessions 
ALTER COLUMN cashier_id DROP NOT NULL;

-- Fix the unique constraint on pos_cashiers for standalone cashiers with NULL user_id
-- Drop the existing constraint that causes conflicts
ALTER TABLE public.pos_cashiers 
DROP CONSTRAINT IF EXISTS pos_cashiers_organization_id_user_id_key;

-- Create a partial unique index that only enforces uniqueness when user_id is NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS pos_cashiers_org_user_unique 
ON public.pos_cashiers (organization_id, user_id) 
WHERE user_id IS NOT NULL;