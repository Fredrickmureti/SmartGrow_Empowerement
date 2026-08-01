-- Phase D: drop the drift columns and rewire the last reader.

-- 1) Legacy shim: stop reading product_packaging.barcode_id; identity now
--    comes from the canonical resolver (which is level-aware already).
CREATE OR REPLACE FUNCTION public.resolve_barcode_v2(p_business_id uuid, p_branch_id uuid, p_code text)
 RETURNS TABLE(product_id uuid, packaging_id uuid, qty_in_base_uom numeric, scan_weight numeric, match_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    r.product_id,
    r.packaging_id,
    COALESCE(r.qty_in_base_uom, 1)::numeric,
    NULL::numeric,
    CASE WHEN r.packaging_id IS NOT NULL THEN 'packaging' ELSE 'identifier' END
  FROM public.resolve_product_identity(p_business_id, p_code, p_branch_id) AS r
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Fallback: weighted-EAN / embedded-price rules still live in
  -- pos_resolve_barcode.
  RETURN QUERY
  SELECT
    (r->>'product_id')::uuid,
    NULL::uuid,
    COALESCE((r->>'scan_quantity')::numeric, 1),
    NULLIF(r->>'scan_weight','')::numeric,
    COALESCE(r->>'match_source','pos_resolve_barcode')
  FROM public.pos_resolve_barcode(p_business_id, p_branch_id, p_code) AS r
  LIMIT 1;
END $function$;

REVOKE EXECUTE ON FUNCTION public.resolve_barcode_v2(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_barcode_v2(uuid, uuid, text) TO authenticated, service_role;

-- 2) Drop the drift columns.
ALTER TABLE public.product_packaging DROP COLUMN IF EXISTS barcode_id;
ALTER TABLE public.product_identifiers DROP COLUMN IF EXISTS pack_quantity;

-- 3) Guard: an identifier's packaging level must belong to the same product
--    and business as the identifier itself (the invariant the dropped
--    inverse column used to blur).
CREATE OR REPLACE FUNCTION public._product_identifier_packaging_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_product uuid;
  v_business uuid;
BEGIN
  IF NEW.packaging_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT pp.product_id, pp.business_id
    INTO v_product, v_business
    FROM public.product_packaging pp
   WHERE pp.id = NEW.packaging_id;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'packaging level % does not exist', NEW.packaging_id;
  END IF;
  IF v_product <> NEW.product_id THEN
    RAISE EXCEPTION 'packaging level % belongs to a different product', NEW.packaging_id;
  END IF;
  IF NEW.business_id IS NOT NULL AND v_business IS NOT NULL AND v_business <> NEW.business_id THEN
    RAISE EXCEPTION 'packaging level % belongs to a different business', NEW.packaging_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_product_identifier_packaging_guard ON public.product_identifiers;
CREATE TRIGGER trg_product_identifier_packaging_guard
BEFORE INSERT OR UPDATE OF packaging_id, product_id ON public.product_identifiers
FOR EACH ROW EXECUTE FUNCTION public._product_identifier_packaging_guard();