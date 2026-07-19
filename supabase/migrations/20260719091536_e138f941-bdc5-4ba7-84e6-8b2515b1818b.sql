-- Wave 3 · Phase 4 postmortem: drop the legacy 6-arg overload of
-- pos_payment_session_open that was left behind when the 9-arg snapshot
-- version shipped in Phase 4.d. Two overloads → PostgREST PGRST203
-- ("Could not choose the best candidate function") → HTTP 400 on every
-- checkout. Mirrors ADR 0009's finalize_table_order cleanup.
DROP FUNCTION IF EXISTS public.pos_payment_session_open(
  uuid, numeric, text, text, numeric, uuid
);