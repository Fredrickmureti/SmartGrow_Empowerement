-- Phase 4: Age Verification for Restricted Items

-- Add age restriction columns to products
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS is_age_restricted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS min_age INTEGER CHECK (min_age IS NULL OR min_age >= 0);

-- Add age verification columns to pos_transactions
ALTER TABLE public.pos_transactions 
ADD COLUMN IF NOT EXISTS age_verified_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS age_verification_method TEXT CHECK (age_verification_method IS NULL OR age_verification_method IN ('id_check', 'dob_entry', 'manager_override')),
ADD COLUMN IF NOT EXISTS age_verified_at TIMESTAMPTZ;

-- Create product categories for restricted items (if needed)
CREATE INDEX IF NOT EXISTS idx_products_age_restricted ON products(is_age_restricted) WHERE is_age_restricted = true;