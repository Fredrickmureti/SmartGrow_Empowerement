
-- Phase 1: Add purchase-side GL mapping to products and vendor accounting defaults to contacts

-- 1. Add purchase_account_id to products table
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS purchase_account_id uuid REFERENCES public.accounts(id);

-- 2. Add default_expense_account_id to contacts table (vendor default expense account)
ALTER TABLE public.contacts
ADD COLUMN IF NOT EXISTS default_expense_account_id uuid REFERENCES public.accounts(id);

-- 3. Add default_payable_account_id to contacts table (optional sub-ledger AP)
ALTER TABLE public.contacts
ADD COLUMN IF NOT EXISTS default_payable_account_id uuid REFERENCES public.accounts(id);

-- Add comments for documentation
COMMENT ON COLUMN public.products.purchase_account_id IS 'Default expense/purchase GL account when this product appears on a bill';
COMMENT ON COLUMN public.contacts.default_expense_account_id IS 'Default expense GL account for this vendor - auto-populates bill lines';
COMMENT ON COLUMN public.contacts.default_payable_account_id IS 'Optional sub-ledger AP account for this vendor';
