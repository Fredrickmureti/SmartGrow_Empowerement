
-- Add source_return_id to credit_notes for bidirectional linking
ALTER TABLE public.credit_notes 
  ADD COLUMN IF NOT EXISTS source_return_id UUID REFERENCES public.sales_returns(id);

-- Add refund tracking columns to credit_notes
ALTER TABLE public.credit_notes 
  ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_date DATE,
  ADD COLUMN IF NOT EXISTS refund_method TEXT;

-- Create index for source_return_id lookups
CREATE INDEX IF NOT EXISTS idx_credit_notes_source_return_id 
  ON public.credit_notes(source_return_id) WHERE source_return_id IS NOT NULL;
