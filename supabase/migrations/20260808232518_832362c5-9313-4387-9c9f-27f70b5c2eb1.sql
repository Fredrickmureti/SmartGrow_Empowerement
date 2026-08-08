DROP FUNCTION IF EXISTS public.convert_estimate_to_invoice_atomic(uuid, uuid);
NOTIFY pgrst, 'reload schema';