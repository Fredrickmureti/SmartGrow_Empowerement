
-- Add account_id to expense_categories to map categories to GL expense accounts
ALTER TABLE public.expense_categories 
  ADD COLUMN account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.expense_categories.account_id IS 'Maps this expense category to a specific GL expense account for accurate journal entry posting';
