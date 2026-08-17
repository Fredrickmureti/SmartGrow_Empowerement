-- INV-SIM Repair #9: the lot-balance upsert used INSERT ... ON CONFLICT DO
-- UPDATE with the signed delta as the proposed insert value. Postgres
-- evaluates the CHECK constraint (warehouse_stock_lots_qty_nonneg) on the
-- proposed tuple BEFORE conflict resolution, so every negative delta failed
-- with 23514 even when the existing balance was ample. Switch to
-- update-first, insert-only-when-absent.
CREATE OR REPLACE FUNCTION public._maintain_warehouse_stock_lots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_signed_delta numeric;
  v_is_out boolean;
  v_lot_id uuid;
  v_is_lot_tracked boolean;
  v_src_wh uuid;
  v_dst_wh uuid;
  v_abs numeric;
  v_updated int;
BEGIN
  IF NEW.product_id IS NULL OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT warehouse_id INTO v_src_wh FROM public.stock_locations WHERE id = NEW.source_location_id;
  SELECT warehouse_id INTO v_dst_wh FROM public.stock_locations WHERE id = NEW.destination_location_id;

  IF NEW.source_location_id IS NULL AND NEW.destination_location_id IS NULL THEN
    -- Location-less movement: fall back to movement-type semantics.
    v_signed_delta := public.stock_movement_signed_quantity(NEW.movement_type::text, NEW.quantity);
  ELSE
    v_abs := abs(COALESCE(NEW.quantity, 0));
    v_signed_delta := 0;
    IF v_dst_wh IS NOT DISTINCT FROM NEW.warehouse_id AND NEW.destination_location_id IS NOT NULL THEN
      v_signed_delta := v_signed_delta + v_abs;
    END IF;
    IF v_src_wh IS NOT DISTINCT FROM NEW.warehouse_id AND NEW.source_location_id IS NOT NULL THEN
      v_signed_delta := v_signed_delta - v_abs;
    END IF;
  END IF;

  IF v_signed_delta = 0 THEN
    IF NEW.source_location_id IS NOT NULL
       AND (NEW.lot_number IS NULL OR NEW.lot_number = '') THEN
      SELECT is_lot_tracked INTO v_is_lot_tracked FROM public.products WHERE id = NEW.product_id;
      IF COALESCE(v_is_lot_tracked, false) THEN
        RAISE EXCEPTION 'INVENTORY_LOT_REQUIRED: product % is lot-tracked but movement % has no lot_number',
          NEW.product_id, NEW.id USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  v_is_out := v_signed_delta < 0;

  SELECT is_lot_tracked INTO v_is_lot_tracked FROM public.products WHERE id = NEW.product_id;

  IF NEW.lot_number IS NULL OR NEW.lot_number = '' THEN
    IF COALESCE(v_is_lot_tracked, false) AND v_is_out THEN
      RAISE EXCEPTION 'INVENTORY_LOT_REQUIRED: product % is lot-tracked but outbound movement % has no lot_number',
        NEW.product_id, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT id INTO v_lot_id FROM public.stock_lots
   WHERE business_id = NEW.business_id AND product_id = NEW.product_id
     AND lot_number = NEW.lot_number
     AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number)
   LIMIT 1;

  IF v_lot_id IS NULL THEN
    IF v_is_out THEN
      RAISE EXCEPTION 'INVENTORY_UNKNOWN_LOT: lot % does not exist for product % — cannot consume',
        NEW.lot_number, NEW.product_id USING ERRCODE = 'no_data_found';
    END IF;
    INSERT INTO public.stock_lots (organization_id, business_id, product_id, lot_number, serial_number)
    VALUES (NEW.organization_id, NEW.business_id, NEW.product_id, NEW.lot_number, NEW.serial_number)
    ON CONFLICT (business_id, product_id, lot_number, serial_number) DO NOTHING
    RETURNING id INTO v_lot_id;
    IF v_lot_id IS NULL THEN
      SELECT id INTO v_lot_id FROM public.stock_lots
       WHERE business_id = NEW.business_id AND product_id = NEW.product_id
         AND lot_number = NEW.lot_number
         AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number);
    END IF;
  END IF;

  -- Update-first: never presents a negative tuple to the CHECK constraint.
  UPDATE public.warehouse_stock_lots
     SET quantity = quantity + v_signed_delta,
         updated_at = now()
   WHERE business_id = NEW.business_id
     AND warehouse_id = NEW.warehouse_id
     AND product_id = NEW.product_id
     AND lot_id = v_lot_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    IF v_is_out THEN
      RAISE EXCEPTION 'INVENTORY_LOT_NO_BALANCE: lot % has no balance in warehouse % — cannot consume %',
        NEW.lot_number, NEW.warehouse_id, abs(v_signed_delta) USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.warehouse_stock_lots (
      organization_id, business_id, warehouse_id, product_id, lot_id, quantity
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id, v_lot_id, v_signed_delta
    )
    ON CONFLICT (business_id, warehouse_id, product_id, lot_id)
    DO UPDATE SET quantity = public.warehouse_stock_lots.quantity + v_signed_delta;
  END IF;

  RETURN NEW;
END;
$function$;