-- Fix UoM normalize trigger misattached to tables that don't have a `quantity` column.
-- stock_adjustment_items uses `quantity_adjustment`; stock_transfer_items uses
-- `quantity_requested`/`quantity_sent`/`quantity_received`. The generic
-- `_uom_normalize_line()` references NEW.quantity, so any INSERT/UPDATE on
-- those tables raised: record "new" has no field "quantity".

-- 1) Adjustment-line normalizer (operates on quantity_adjustment).
CREATE OR REPLACE FUNCTION public._uom_normalize_adj_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base_uom uuid;
  v_pack_qty numeric;
  v_should_renorm boolean;
  v_sign int;
  v_abs numeric;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN
    -- No base UoM configured — fall back to existing values, never raise.
    IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := NULL; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_adjustment; END IF;
    RETURN NEW;
  END IF;

  v_should_renorm := (TG_OP = 'INSERT') OR (
    NEW.packaging_id      IS DISTINCT FROM OLD.packaging_id
    OR NEW.display_quantity IS DISTINCT FROM OLD.display_quantity
    OR NEW.display_uom_id   IS DISTINCT FROM OLD.display_uom_id
  );

  IF NOT v_should_renorm THEN
    IF NEW.display_uom_id   IS NULL THEN NEW.display_uom_id   := v_base_uom; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_adjustment; END IF;
    RETURN NEW;
  END IF;

  -- Preserve sign of the adjustment (negative = shrinkage/write-off).
  v_sign := CASE WHEN COALESCE(NEW.quantity_adjustment, 0) < 0 THEN -1 ELSE 1 END;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty FROM public.product_packaging WHERE id = NEW.packaging_id;
    IF v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
      IF NEW.display_quantity IS NULL THEN
        NEW.display_quantity := NEW.quantity_adjustment / v_pack_qty;
      END IF;
      v_abs := abs(NEW.display_quantity) * v_pack_qty;
      NEW.quantity_adjustment := v_sign * v_abs;
      IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
      NEW.quantity_after := NEW.quantity_before + NEW.quantity_adjustment;
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.display_uom_id IS NOT NULL AND NEW.display_quantity IS NOT NULL THEN
    IF NEW.display_uom_id = v_base_uom THEN
      NEW.quantity_adjustment := NEW.display_quantity;
    ELSE
      NEW.quantity_adjustment := public.convert_uom(NEW.display_quantity, NEW.display_uom_id, v_base_uom);
    END IF;
    NEW.quantity_after := NEW.quantity_before + NEW.quantity_adjustment;
    RETURN NEW;
  END IF;

  IF NEW.display_uom_id   IS NULL THEN NEW.display_uom_id   := v_base_uom; END IF;
  IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_adjustment; END IF;
  RETURN NEW;
END;
$$;

-- 2) Transfer-line normalizer. quantity_requested is the source of truth at
-- create time; sent/received are filled in by operators downstream and reuse
-- the same display conversion when they're set.
CREATE OR REPLACE FUNCTION public._uom_normalize_xfer_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base_uom uuid;
  v_pack_qty numeric;
  v_should_renorm boolean;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_requested; END IF;
    RETURN NEW;
  END IF;

  v_should_renorm := (TG_OP = 'INSERT') OR (
    NEW.packaging_id      IS DISTINCT FROM OLD.packaging_id
    OR NEW.display_quantity IS DISTINCT FROM OLD.display_quantity
    OR NEW.display_uom_id   IS DISTINCT FROM OLD.display_uom_id
  );

  IF NOT v_should_renorm THEN
    IF NEW.display_uom_id   IS NULL THEN NEW.display_uom_id   := v_base_uom; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_requested; END IF;
    RETURN NEW;
  END IF;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty FROM public.product_packaging WHERE id = NEW.packaging_id;
    IF v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
      IF NEW.display_quantity IS NULL THEN
        NEW.display_quantity := NEW.quantity_requested / v_pack_qty;
      END IF;
      NEW.quantity_requested := NEW.display_quantity * v_pack_qty;
      IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.display_uom_id IS NOT NULL AND NEW.display_quantity IS NOT NULL THEN
    IF NEW.display_uom_id = v_base_uom THEN
      NEW.quantity_requested := NEW.display_quantity;
    ELSE
      NEW.quantity_requested := public.convert_uom(NEW.display_quantity, NEW.display_uom_id, v_base_uom);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.display_uom_id   IS NULL THEN NEW.display_uom_id   := v_base_uom; END IF;
  IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_requested; END IF;
  RETURN NEW;
END;
$$;

-- 3) Swap the wrong triggers off.
DROP TRIGGER IF EXISTS trg_uom_normalize_adj_items  ON public.stock_adjustment_items;
DROP TRIGGER IF EXISTS trg_uom_normalize_xfer_items ON public.stock_transfer_items;

CREATE TRIGGER trg_uom_normalize_adj_items
  BEFORE INSERT OR UPDATE ON public.stock_adjustment_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_adj_line();

CREATE TRIGGER trg_uom_normalize_xfer_items
  BEFORE INSERT OR UPDATE ON public.stock_transfer_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_xfer_line();