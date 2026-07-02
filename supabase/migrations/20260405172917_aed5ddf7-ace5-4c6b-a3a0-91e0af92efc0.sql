DROP TRIGGER IF EXISTS track_invoice_usage_trigger ON public.invoices;
DROP FUNCTION IF EXISTS public.track_invoice_usage();