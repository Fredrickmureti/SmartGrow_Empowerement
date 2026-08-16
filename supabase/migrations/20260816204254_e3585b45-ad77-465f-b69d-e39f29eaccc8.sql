-- Retire the pre-Phase-4 overload: two signatures make a 14-argument named call
-- ambiguous, so the single write path must be the only one.
DROP FUNCTION IF EXISTS public.upsert_supplier_item_terms(
  uuid, uuid, uuid, numeric, text, numeric, integer, boolean, date, date, text, uuid, uuid, uuid);