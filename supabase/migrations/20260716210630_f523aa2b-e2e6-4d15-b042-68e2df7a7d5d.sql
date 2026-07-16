-- =====================================================================
-- ADR-0064 Phase 2 — stamp source/destination locations on movements
-- =====================================================================

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS source_location_id      uuid REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS destination_location_id uuid REFERENCES public.stock_locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS stock_movements_source_location_idx
  ON public.stock_movements (source_location_id) WHERE source_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_destination_location_idx
  ON public.stock_movements (destination_location_id) WHERE destination_location_id IS NOT NULL;

-- Upgraded shadow sync: double-entry when both source and destination are
-- stamped; otherwise route to whichever side is stamped; fall back to the
-- warehouse's default location (Phase 1 behaviour) when neither is set.
CREATE OR REPLACE FUNCTION public._maintain_stock_quants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_default_location uuid;
  v_source           uuid;
  v_destination      uuid;
  v_qty              numeric := NEW.quantity;
BEGIN
  IF v_qty = 0 THEN RETURN NEW; END IF;

  v_source      := NEW.source_location_id;
  v_destination := NEW.destination_location_id;

  IF v_source IS NULL AND v_destination IS NULL THEN
    IF NEW.warehouse_id IS NULL THEN RETURN NEW; END IF;
    SELECT id INTO v_default_location
    FROM public.stock_locations
    WHERE warehouse_id = NEW.warehouse_id AND is_default
    LIMIT 1;
    IF v_default_location IS NULL THEN RETURN NEW; END IF;

    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_default_location, NEW.lot_number, v_qty)
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
    RETURN NEW;
  END IF;

  -- Destination side (positive)
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
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  -- Source side (negative)
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
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  RETURN NEW;
END $$;
