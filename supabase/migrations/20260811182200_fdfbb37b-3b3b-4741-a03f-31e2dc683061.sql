-- 1. Serialise the returnable-quantity check per goods receipt line so two
--    concurrent returns cannot each pass the check and jointly over-return.
CREATE OR REPLACE FUNCTION public._pret_lock_receipt_line(_goods_receipt_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _goods_receipt_item_id IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pret_grn_item_' || _goods_receipt_item_id::text));
  PERFORM 1 FROM public.goods_receipt_items WHERE id = _goods_receipt_item_id FOR UPDATE;
END;
$$;

REVOKE ALL ON FUNCTION public._pret_lock_receipt_line(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._pret_lock_receipt_line(uuid) TO service_role;

-- 2. Tighten the status domain: drop the obsolete legacy values.
ALTER TABLE public.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_status_chk;
ALTER TABLE public.purchase_returns ADD CONSTRAINT purchase_returns_status_chk
  CHECK (status = ANY (ARRAY[
    'draft','submitted','approved','rejected','dispatched',
    'acknowledged','credited','closed','cancelled'
  ]));