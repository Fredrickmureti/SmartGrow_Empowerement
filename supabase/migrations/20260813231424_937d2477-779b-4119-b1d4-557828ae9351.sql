ALTER TABLE public.product_packaging
  ADD COLUMN IF NOT EXISTS parent_packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qty_in_parent numeric NULL,
  ADD COLUMN IF NOT EXISTS is_shipping_unit boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.product_packaging.parent_packaging_id IS
  'Immediate parent level in the packaging hierarchy (piece -> pack -> box -> carton -> pallet). NULL = a level defined directly against the base unit.';
COMMENT ON COLUMN public.product_packaging.qty_in_parent IS
  'How many of the PARENT level this level contains. Derived arithmetic still uses qty_in_base_uom, which remains canonical.';
COMMENT ON COLUMN public.product_packaging.is_shipping_unit IS
  'Marks the level logistics treats as the shipping/handling unit.';

CREATE INDEX IF NOT EXISTS product_packaging_parent_idx
  ON public.product_packaging (parent_packaging_id)
  WHERE parent_packaging_id IS NOT NULL;

-- One shipping unit per product.
CREATE UNIQUE INDEX IF NOT EXISTS product_packaging_one_shipping_unit_uidx
  ON public.product_packaging (product_id)
  WHERE is_shipping_unit IS TRUE;

CREATE OR REPLACE FUNCTION public._enforce_packaging_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_parent public.product_packaging;
  v_cursor uuid;
  v_depth int := 0;
  v_expected numeric;
BEGIN
  IF NEW.qty_in_base_uom IS NULL OR NEW.qty_in_base_uom <= 0 THEN
    RAISE EXCEPTION 'PACKAGING_INVALID: qty_in_base_uom must be greater than zero'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.parent_packaging_id IS NULL THEN
    IF NEW.qty_in_parent IS NOT NULL THEN
      RAISE EXCEPTION 'PACKAGING_INVALID: qty_in_parent requires a parent level'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_packaging_id = NEW.id THEN
    RAISE EXCEPTION 'PACKAGING_CYCLE: a packaging level cannot be its own parent'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_parent FROM public.product_packaging WHERE id = NEW.parent_packaging_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PACKAGING_INVALID: parent packaging level does not exist'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_parent.product_id <> NEW.product_id
     OR v_parent.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'PACKAGING_SCOPE: parent packaging level belongs to a different product or business'
      USING ERRCODE = 'P0001';
  END IF;

  -- Cycle and depth check by walking up from the parent.
  v_cursor := v_parent.id;
  WHILE v_cursor IS NOT NULL LOOP
    v_depth := v_depth + 1;
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'PACKAGING_CYCLE: this parent would create a loop in the packaging hierarchy'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_depth > 8 THEN
      RAISE EXCEPTION 'PACKAGING_DEPTH: packaging hierarchy is limited to 8 levels'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT parent_packaging_id INTO v_cursor
      FROM public.product_packaging WHERE id = v_cursor;
  END LOOP;

  IF NEW.qty_in_parent IS NULL THEN
    -- Derive it from the canonical base quantities.
    IF NEW.qty_in_base_uom % v_parent.qty_in_base_uom <> 0
       AND round(NEW.qty_in_base_uom / v_parent.qty_in_base_uom, 6)
           <> NEW.qty_in_base_uom / v_parent.qty_in_base_uom THEN
      NULL; -- non-integral ratios are allowed; store the exact ratio below
    END IF;
    NEW.qty_in_parent := NEW.qty_in_base_uom / v_parent.qty_in_base_uom;
  END IF;

  IF NEW.qty_in_parent <= 0 THEN
    RAISE EXCEPTION 'PACKAGING_INVALID: qty_in_parent must be greater than zero'
      USING ERRCODE = 'P0001';
  END IF;

  v_expected := v_parent.qty_in_base_uom * NEW.qty_in_parent;
  IF abs(v_expected - NEW.qty_in_base_uom) > greatest(v_expected, NEW.qty_in_base_uom) * 0.000001 THEN
    RAISE EXCEPTION
      'PACKAGING_INCONSISTENT: % of "%" is % base units, but this level declares % base units',
      NEW.qty_in_parent, v_parent.name, v_expected, NEW.qty_in_base_uom
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_packaging_hierarchy ON public.product_packaging;
CREATE TRIGGER trg_enforce_packaging_hierarchy
  BEFORE INSERT OR UPDATE OF parent_packaging_id, qty_in_parent, qty_in_base_uom, product_id, business_id
  ON public.product_packaging
  FOR EACH ROW EXECUTE FUNCTION public._enforce_packaging_hierarchy();

-- Re-validate children when a parent's base quantity moves, so the hierarchy
-- can never be left internally contradictory.
CREATE OR REPLACE FUNCTION public._repropagate_packaging_children()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.qty_in_base_uom IS DISTINCT FROM OLD.qty_in_base_uom THEN
    IF EXISTS (
      SELECT 1 FROM public.product_packaging c
       WHERE c.parent_packaging_id = NEW.id
         AND abs(NEW.qty_in_base_uom * c.qty_in_parent - c.qty_in_base_uom)
             > greatest(NEW.qty_in_base_uom * c.qty_in_parent, c.qty_in_base_uom) * 0.000001
    ) THEN
      RAISE EXCEPTION
        'PACKAGING_INCONSISTENT: changing "%" to % base units contradicts a level nested inside it',
        NEW.name, NEW.qty_in_base_uom
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_repropagate_packaging_children ON public.product_packaging;
CREATE TRIGGER trg_repropagate_packaging_children
  AFTER UPDATE OF qty_in_base_uom ON public.product_packaging
  FOR EACH ROW EXECUTE FUNCTION public._repropagate_packaging_children();