-- Drop the legacy 3-arg finalize_table_order overload that does not persist
-- tendered_amount / change_given. The 4-arg version (with p_created_by) is the
-- single source of truth — see docs/adr/0009-pos-payment-state-model.md.
DROP FUNCTION IF EXISTS public.finalize_table_order(uuid, jsonb, numeric);