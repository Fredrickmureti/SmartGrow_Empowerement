-- Drop the stale legacy 6-arg overload of record_partial_delivery_atomic.
-- The canonical 7-arg version (with p_received_by_user_id audit column) is the
-- only one the application calls. Removing the legacy overload eliminates a
-- latent PostgREST function-resolution ambiguity hazard.
DROP FUNCTION IF EXISTS public.record_partial_delivery_atomic(
  uuid,    -- p_dn_id
  uuid,    -- p_user_id
  jsonb,   -- p_line_qtys
  boolean, -- p_create_backorder
  text,    -- p_received_by
  jsonb    -- p_pod
);