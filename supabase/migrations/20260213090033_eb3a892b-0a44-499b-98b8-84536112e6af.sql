-- Add missing customer_tin column to pos_transactions
ALTER TABLE public.pos_transactions ADD COLUMN IF NOT EXISTS customer_tin TEXT;