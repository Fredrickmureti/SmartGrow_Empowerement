-- Freeze the printed unit label at save time. Tables without a
-- `uom_snapshot` column are unaffected: jsonb_populate_record ignores keys
-- that do not map to a field of the row type.
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
  v_row jsonb;
  v_label text;
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

  -- Frozen human label for printed documents ("Bag × 50", "KG").
  v_label := v_res->>'uom_snapshot';
  IF v_label IS NOT NULL THEN
    v_row := to_jsonb(NEW);
    IF v_row ? 'uom_snapshot' AND COALESCE(v_row->>'uom_snapshot', '') = '' THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('uom_snapshot', v_label));
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;