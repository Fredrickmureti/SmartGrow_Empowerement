-- ADR 0123 §2: no parallel implementations. Two independent bodies existed for
-- confirm_invoice_and_release_stock_atomic; the 5-arg copy duplicated the 6-arg
-- one (both default the invoice status to 'confirmed'). Drop the duplicate.
DROP FUNCTION IF EXISTS public.confirm_invoice_and_release_stock_atomic(uuid, uuid, jsonb, boolean, uuid);
