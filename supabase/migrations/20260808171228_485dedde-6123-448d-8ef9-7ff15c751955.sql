ALTER TABLE public.product_categories
  ADD COLUMN IF NOT EXISTS sales_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purchase_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cogs_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inventory_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.product_categories.sales_account_id IS 'Category-level revenue account. Ladder: line override -> product -> category (walking parent_id) -> company default.';
COMMENT ON COLUMN public.product_categories.purchase_account_id IS 'Category-level purchase/expense account. Ladder: line override -> product -> category -> company default.';
COMMENT ON COLUMN public.product_categories.cogs_account_id IS 'Category-level COGS account. Ladder: line override -> product -> category -> company default.';
COMMENT ON COLUMN public.product_categories.inventory_account_id IS 'Category-level inventory asset account. Ladder: line override -> product -> category -> company default.';

CREATE INDEX IF NOT EXISTS idx_product_categories_parent_id ON public.product_categories(parent_id);