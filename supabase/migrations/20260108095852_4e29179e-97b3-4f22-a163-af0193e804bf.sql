-- Fix RLS on invoice_items
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

-- Fix RLS on transaction_lines  
ALTER TABLE public.transaction_lines ENABLE ROW LEVEL SECURITY;