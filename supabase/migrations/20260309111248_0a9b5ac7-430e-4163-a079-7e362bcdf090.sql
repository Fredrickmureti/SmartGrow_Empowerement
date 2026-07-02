-- Add business_id column to expense_categories for multi-business isolation
ALTER TABLE public.expense_categories 
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_expense_categories_business_id ON public.expense_categories(business_id);

COMMENT ON COLUMN public.expense_categories.business_id 
  IS 'Scopes category to a specific business. NULL = org-wide shared category.';