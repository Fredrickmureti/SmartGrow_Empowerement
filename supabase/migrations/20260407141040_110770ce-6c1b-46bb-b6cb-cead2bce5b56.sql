-- Phase 1: Add debit_account_id to pos_payment_methods for GL journal linkage
ALTER TABLE public.pos_payment_methods
ADD COLUMN debit_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL;