-- One conversion engine: the BEFORE-INSERT/UPDATE line normalizer now
-- delegates to public.resolve_line_base_quantity instead of re-implementing
-- packaging and UoM maths.
CREATE OR REPLACE FUNCTION public._uom_normalize_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom uuid;
  v_should_renorm boolean;
  v_res jsonb;
  v_display numeric;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  v_should_renorm := (TG_OP = 'INSERT') OR (
    NEW.packaging_id IS DISTINCT FROM OLD.packaging_id
    OR NEW.display_quantity IS DISTINCT FROM OLD.display_quantity
    OR NEW.display_uom_id IS DISTINCT FROM OLD.display_uom_id
  );

  IF NOT v_should_renorm THEN
    IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity; END IF;
    RETURN NEW;
  END IF;

  -- Derive the customer-facing quantity when only the base quantity is known.
  v_display := NEW.display_quantity;
  IF v_display IS NULL THEN
    IF NEW.packaging_id IS NOT NULL THEN
      SELECT NEW.quantity / NULLIF(pk.qty_in_base_uom, 0)
        INTO v_display
        FROM public.product_packaging pk
       WHERE pk.id = NEW.packaging_id;
    END IF;
    v_display := COALESCE(v_display, NEW.quantity);
  END IF;

  v_res := public.resolve_line_base_quantity(
             NULL, NEW.product_id, v_display, NEW.display_uom_id, NEW.packaging_id);

  NEW.quantity         := (v_res->>'base_quantity')::numeric;
  NEW.display_quantity := v_display;
  NEW.display_uom_id   := COALESCE((v_res->>'display_uom_id')::uuid, v_base_uom);
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public._uom_normalize_line() IS
  'Line quantity normalizer. Sets quantity (base UoM) from display_quantity + display_uom_id | packaging_id via public.resolve_line_base_quantity. Fail-closed on unknown packaging or cross-dimension conversion.';