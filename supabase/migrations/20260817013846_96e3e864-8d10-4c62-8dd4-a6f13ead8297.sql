-- INV-SIM Repair #10: location-less movements posted their whole negative
-- delta to the warehouse default location, producing negative quants there
-- while the bin that really held the stock stayed overstated. Allocate
-- decrements across the locations that actually hold the product (and lot),
-- largest balance first; only an unsatisfiable remainder falls back to the
-- default location so authoritative postings (physical counts) still land.
CREATE OR REPLACE FUNCTION public._maintain_stock_quants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_default_location uuid;
  v_source           uuid;
  v_destination      uuid;
  v_qty              numeric := NEW.quantity;
  v_remaining        numeric;
  v_take             numeric;
  v_q                record;
BEGIN
  IF v_qty = 0 THEN RETURN NEW; END IF;

  -- LPN operations relocate plate-scoped quants themselves; the movement
  -- rows they write are an audit trail, not a balance instruction.
  IF NEW.reference_type = 'wms_lpn' THEN RETURN NEW; END IF;

  v_source      := NEW.source_location_id;
  v_destination := NEW.destination_location_id;

  IF v_source IS NULL AND v_destination IS NULL THEN
    IF NEW.warehouse_id IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_MOVEMENT_NO_LOCATION: movement % has neither a warehouse nor source/destination locations; the quant ledger cannot be maintained', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT id INTO v_default_location
    FROM public.stock_locations
    WHERE warehouse_id = NEW.warehouse_id AND is_default
    LIMIT 1;

    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_WAREHOUSE_NO_DEFAULT_LOCATION: warehouse % has no default stock location; create one before posting stock', NEW.warehouse_id
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_qty < 0 THEN
      v_remaining := abs(v_qty);

      FOR v_q IN
        SELECT q.id, q.quantity
          FROM public.stock_quants q
          JOIN public.stock_locations l ON l.id = q.location_id
         WHERE l.warehouse_id = NEW.warehouse_id
           AND q.product_id = NEW.product_id
           AND q.quantity > 0
           AND (NEW.lot_number IS NULL OR q.lot_number IS NOT DISTINCT FROM NEW.lot_number)
         ORDER BY q.quantity DESC, q.id
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_q.quantity, v_remaining);
        UPDATE public.stock_quants
           SET quantity = quantity - v_take, updated_at = now()
         WHERE id = v_q.id;
        v_remaining := v_remaining - v_take;
      END LOOP;

      IF v_remaining > 0 THEN
        -- Nothing left to draw from: keep the authoritative posting, and let
        -- the shortfall be visible on the default location.
        INSERT INTO public.stock_quants AS q
          (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
        VALUES
          (NEW.organization_id, NEW.business_id, NEW.branch_id,
           NEW.product_id, v_default_location, NEW.lot_number, -v_remaining)
        ON CONFLICT (
          product_id, location_id,
          COALESCE(lot_number, ''),
          COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
        ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
      END IF;

      RETURN NEW;
    END IF;

    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_default_location, NEW.lot_number, v_qty)
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
    RETURN NEW;
  END IF;

  IF v_destination IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_destination, NEW.lot_number, ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  IF v_source IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_source, NEW.lot_number, -ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  RETURN NEW;
END $function$;