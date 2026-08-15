-- Phase 3 — physical-ledger provenance.
-- The ledger already stored the canonical BASE quantity plus source_packaging_id /
-- source_uom_id. It could not state the COMMERCIAL quantity ("1 Bag") without
-- joining back to the originating document line, and it froze nothing, so a later
-- packaging edit silently re-interpreted history. These columns mirror the
-- structured snapshot already carried by all 15 document-line tables.

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS display_quantity        numeric(15,4),
  ADD COLUMN IF NOT EXISTS uom_snapshot_pack_name  text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_factor     numeric(15,6),
  ADD COLUMN IF NOT EXISTS uom_snapshot_base_code  text;

ALTER TABLE public.stock_quants
  ADD COLUMN IF NOT EXISTS display_quantity        numeric(15,4),
  ADD COLUMN IF NOT EXISTS uom_snapshot_pack_name  text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_factor     numeric(15,6),
  ADD COLUMN IF NOT EXISTS uom_snapshot_base_code  text;

COMMENT ON COLUMN public.stock_movements.quantity IS
  'Canonical quantity in the product''s BASE unit of measure (products.base_uom_id). Never a pack count.';
COMMENT ON COLUMN public.stock_movements.display_quantity IS
  'Commercial quantity as transacted (pack count when source_packaging_id is set, else base units).';
COMMENT ON COLUMN public.stock_movements.uom_snapshot_factor IS
  'Base units per display unit, frozen at write time. Immune to later product_packaging edits.';
COMMENT ON COLUMN public.stock_quants.quantity IS
  'On-hand quantity in the product''s BASE unit of measure. Never a pack count.';
COMMENT ON COLUMN public.stock_quants.display_quantity IS
  'On-hand expressed in the packaging level referenced by package_id, when one is set.';

-- Shared stamping rule. No new arithmetic: the factor is product_packaging.qty_in_base_uom,
-- exactly as enforce_line_uom_consistency and resolve_line_base_quantity use it.
CREATE OR REPLACE FUNCTION public._stamp_ledger_uom_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pack_id    uuid;
  v_pack_name  text;
  v_factor     numeric;
  v_base_uom   uuid;
  v_base_code  text;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Already frozen: never rewrite. History keeps the meaning it was written with.
  IF NEW.uom_snapshot_factor IS NOT NULL
     AND NEW.uom_snapshot_base_code IS NOT NULL
     AND NEW.display_quantity IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_pack_id := CASE TG_TABLE_NAME
                 WHEN 'stock_movements' THEN NEW.source_packaging_id
                 ELSE NEW.package_id
               END;

  SELECT p.base_uom_id INTO v_base_uom FROM public.products p WHERE p.id = NEW.product_id;
  IF v_base_uom IS NOT NULL THEN
    SELECT COALESCE(u.code, u.name) INTO v_base_code
      FROM public.units_of_measure u WHERE u.id = v_base_uom;
  END IF;

  IF v_pack_id IS NOT NULL THEN
    SELECT pp.name, pp.qty_in_base_uom INTO v_pack_name, v_factor
      FROM public.product_packaging pp WHERE pp.id = v_pack_id;
  END IF;

  v_factor := COALESCE(NULLIF(v_factor, 0), 1);

  IF NEW.uom_snapshot_pack_name IS NULL THEN
    NEW.uom_snapshot_pack_name := v_pack_name;
  END IF;
  IF NEW.uom_snapshot_factor IS NULL THEN
    NEW.uom_snapshot_factor := v_factor;
  END IF;
  -- Deliberately NOT defaulted to 'ea': an unconfigured base UoM must surface
  -- as missing data, not be silently invented.
  IF NEW.uom_snapshot_base_code IS NULL THEN
    NEW.uom_snapshot_base_code := v_base_code;
  END IF;
  IF NEW.display_quantity IS NULL AND NEW.quantity IS NOT NULL THEN
    NEW.display_quantity := NEW.quantity / NEW.uom_snapshot_factor;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_ledger_uom_snapshot ON public.stock_movements;
CREATE TRIGGER trg_stamp_ledger_uom_snapshot
  BEFORE INSERT OR UPDATE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public._stamp_ledger_uom_snapshot();

DROP TRIGGER IF EXISTS trg_stamp_ledger_uom_snapshot ON public.stock_quants;
CREATE TRIGGER trg_stamp_ledger_uom_snapshot
  BEFORE INSERT OR UPDATE ON public.stock_quants
  FOR EACH ROW EXECUTE FUNCTION public._stamp_ledger_uom_snapshot();

-- Backfill: derive only what is still derivable; leave the rest NULL rather than guess.
UPDATE public.stock_movements m
   SET uom_snapshot_pack_name = COALESCE(m.uom_snapshot_pack_name, pp.name),
       uom_snapshot_factor    = COALESCE(m.uom_snapshot_factor, NULLIF(pp.qty_in_base_uom, 0), 1),
       uom_snapshot_base_code = COALESCE(m.uom_snapshot_base_code, u.code, u.name),
       display_quantity       = COALESCE(
                                  m.display_quantity,
                                  m.quantity / COALESCE(NULLIF(pp.qty_in_base_uom, 0), 1))
  FROM public.products p
  LEFT JOIN public.units_of_measure u ON u.id = p.base_uom_id
  LEFT JOIN public.product_packaging pp ON FALSE
 WHERE p.id = m.product_id
   AND m.uom_snapshot_factor IS NULL
   AND m.source_packaging_id IS NULL;

UPDATE public.stock_movements m
   SET uom_snapshot_pack_name = COALESCE(m.uom_snapshot_pack_name, pp.name),
       uom_snapshot_factor    = COALESCE(m.uom_snapshot_factor, NULLIF(pp.qty_in_base_uom, 0), 1),
       uom_snapshot_base_code = COALESCE(m.uom_snapshot_base_code, u.code, u.name),
       display_quantity       = COALESCE(
                                  m.display_quantity,
                                  m.quantity / COALESCE(NULLIF(pp.qty_in_base_uom, 0), 1))
  FROM public.product_packaging pp
  JOIN public.products p ON p.id = pp.product_id
  LEFT JOIN public.units_of_measure u ON u.id = p.base_uom_id
 WHERE pp.id = m.source_packaging_id
   AND m.uom_snapshot_factor IS NULL;

UPDATE public.stock_quants q
   SET uom_snapshot_pack_name = COALESCE(q.uom_snapshot_pack_name, pp.name),
       uom_snapshot_factor    = COALESCE(q.uom_snapshot_factor, NULLIF(pp.qty_in_base_uom, 0), 1),
       uom_snapshot_base_code = COALESCE(q.uom_snapshot_base_code, u.code, u.name),
       display_quantity       = COALESCE(
                                  q.display_quantity,
                                  q.quantity / COALESCE(NULLIF(pp.qty_in_base_uom, 0), 1))
  FROM public.products p
  LEFT JOIN public.units_of_measure u ON u.id = p.base_uom_id
  LEFT JOIN public.product_packaging pp ON pp.product_id = p.id
 WHERE p.id = q.product_id
   AND (q.package_id IS NULL OR pp.id = q.package_id)
   AND (q.package_id IS NOT NULL OR pp.id IS NULL)
   AND q.uom_snapshot_factor IS NULL;