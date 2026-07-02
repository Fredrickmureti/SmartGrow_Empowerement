-- Phase 1: Customer Credit Management
-- Add credit management fields to contacts table

ALTER TABLE public.contacts
ADD COLUMN IF NOT EXISTS credit_limit NUMERIC DEFAULT NULL,
ADD COLUMN IF NOT EXISTS credit_hold BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS payment_term_id UUID REFERENCES public.payment_terms(id),
ADD COLUMN IF NOT EXISTS price_list_id UUID REFERENCES public.price_lists(id),
ADD COLUMN IF NOT EXISTS customer_group TEXT DEFAULT NULL;

-- Add index for faster credit queries
CREATE INDEX IF NOT EXISTS idx_contacts_credit_hold ON public.contacts(credit_hold) WHERE credit_hold = true;
CREATE INDEX IF NOT EXISTS idx_contacts_customer_group ON public.contacts(customer_group) WHERE customer_group IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.contacts.credit_limit IS 'Maximum credit amount allowed for this customer. NULL means no limit.';
COMMENT ON COLUMN public.contacts.credit_hold IS 'When true, blocks new orders for this customer until resolved.';
COMMENT ON COLUMN public.contacts.customer_group IS 'Customer segment for group-based pricing (e.g., Wholesale, Retail, VIP).';