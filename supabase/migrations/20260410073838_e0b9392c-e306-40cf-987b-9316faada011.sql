-- Add source_recurring_id column to invoices
ALTER TABLE public.invoices
ADD COLUMN source_recurring_id UUID REFERENCES public.recurring_invoices(id) ON DELETE SET NULL;

-- Create index for efficient lookups
CREATE INDEX idx_invoices_source_recurring_id ON public.invoices(source_recurring_id) WHERE source_recurring_id IS NOT NULL;