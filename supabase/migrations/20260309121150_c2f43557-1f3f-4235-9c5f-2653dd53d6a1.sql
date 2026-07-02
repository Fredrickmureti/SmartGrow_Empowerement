
-- Add source_expense_id to bills table to link auto-created bills back to their originating expense
ALTER TABLE public.bills ADD COLUMN source_expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL;

-- Partial index: only index rows where the column is populated
CREATE INDEX idx_bills_source_expense ON public.bills(source_expense_id) WHERE source_expense_id IS NOT NULL;

-- RLS: the existing bills policies already cover this column since they filter by organization_id
