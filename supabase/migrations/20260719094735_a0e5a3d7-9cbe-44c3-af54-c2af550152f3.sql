-- Restore missing POS stock reservation compatibility relation used by process_pos_transaction.
-- The canonical table remains public.stock_reservations; this view preserves the
-- legacy contract for checkout code that still reads/deletes pos_stock_reservations.

CREATE OR REPLACE VIEW public.pos_stock_reservations
WITH (security_invoker = true) AS
SELECT
  sr.id,
  sr.organization_id,
  sr.business_id,
  sr.branch_id,
  sr.source_id AS register_id,
  sr.product_id,
  sr.quantity,
  sr.reserved_by,
  sr.expires_at,
  sr.created_at
FROM public.stock_reservations sr
WHERE sr.source_type = 'pos'
  AND sr.released_at IS NULL
  AND (sr.expires_at IS NULL OR sr.expires_at > now());

COMMENT ON VIEW public.pos_stock_reservations IS
  'Compatibility view over stock_reservations for POS checkout. Canonical reservation storage is stock_reservations.';

GRANT SELECT ON public.pos_stock_reservations TO authenticated;
GRANT SELECT ON public.pos_stock_reservations TO anon;
GRANT ALL ON public.pos_stock_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.tg_pos_stock_reservations_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE id = OLD.id
     AND source_type = 'pos'
     AND released_at IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_stock_reservations_soft_delete ON public.pos_stock_reservations;
CREATE TRIGGER trg_pos_stock_reservations_soft_delete
INSTEAD OF DELETE ON public.pos_stock_reservations
FOR EACH ROW EXECUTE FUNCTION public.tg_pos_stock_reservations_soft_delete();

GRANT EXECUTE ON FUNCTION public.tg_pos_stock_reservations_soft_delete() TO authenticated, service_role;