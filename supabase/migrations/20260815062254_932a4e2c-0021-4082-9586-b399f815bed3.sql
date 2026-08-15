CREATE OR REPLACE FUNCTION public._stamp_ledger_uom_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pack_id    uuid;
  v_pack_name  text;
  v_factor     numeric;
  v_base_uom   uuid;
  v_base_code  text;
  v_row        jsonb;
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

  -- Field name differs per ledger table; resolve through jsonb so plpgsql never
  -- has to parse a column that does not exist on the firing table.
  v_row := to_jsonb(NEW);
  v_pack_id := COALESCE(
    NULLIF(v_row->>'source_packaging_id','')::uuid,
    NULLIF(v_row->>'package_id','')::uuid
  );

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
$function$;