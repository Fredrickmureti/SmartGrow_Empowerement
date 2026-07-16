
-- =============================================================
-- Phase 4: transit + quarantine locations, lot_quarantine wiring
-- =============================================================

-- 1) Relax warehouse_id for business-scoped virtual transit locations
ALTER TABLE public.stock_locations
  ALTER COLUMN warehouse_id DROP NOT NULL;

ALTER TABLE public.stock_locations
  DROP CONSTRAINT IF EXISTS stock_locations_warehouse_or_transit_chk;

ALTER TABLE public.stock_locations
  ADD CONSTRAINT stock_locations_warehouse_or_transit_chk
  CHECK (
    warehouse_id IS NOT NULL
    OR location_type = 'transit'
  );

-- 2) Uniqueness invariants
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_locations_business_transit
  ON public.stock_locations (business_id)
  WHERE location_type = 'transit' AND warehouse_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_locations_warehouse_quarantine
  ON public.stock_locations (warehouse_id)
  WHERE location_type = 'quarantine';

-- 3) Seed transit locations (one per business)
INSERT INTO public.stock_locations (
  organization_id, business_id, branch_id, warehouse_id, parent_location_id,
  code, name, location_type, usage, is_active, is_default
)
SELECT DISTINCT
  b.organization_id, b.id, NULL::uuid, NULL::uuid, NULL::uuid,
  'TRANSIT', 'In Transit', 'transit'::stock_location_type,
  'virtual'::stock_location_usage, true, false
FROM public.businesses b
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_locations sl
  WHERE sl.business_id = b.id
    AND sl.location_type = 'transit'
    AND sl.warehouse_id IS NULL
);

-- 4) Seed quarantine locations (one per warehouse)
INSERT INTO public.stock_locations (
  organization_id, business_id, branch_id, warehouse_id, parent_location_id,
  code, name, location_type, usage, is_active, is_default
)
SELECT
  w.organization_id, w.business_id, w.branch_id, w.id, NULL::uuid,
  'QUARANTINE', 'Quarantine', 'quarantine'::stock_location_type,
  'inspection'::stock_location_usage, true, false
FROM public.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_locations sl
  WHERE sl.warehouse_id = w.id
    AND sl.location_type = 'quarantine'
);

-- 5) lot_quarantine → stock_movements emitter
CREATE OR REPLACE FUNCTION public._emit_quarantine_movements()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_lot_number text;
  v_business_id uuid;
  v_organization_id uuid;
  v_branch_id uuid;
  v_warehouse_id uuid;
  v_storage_loc uuid;
  v_quarantine_loc uuid;
  v_qty numeric;
BEGIN
  -- Only act on newly-quarantined or newly-released rows.
  IF (TG_OP = 'INSERT' AND NEW.status = 'quarantined')
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
         AND NEW.status IN ('quarantined','released'))
  THEN
    SELECT l.product_id, l.lot_number, l.business_id,
           l.organization_id, l.branch_id
      INTO v_product_id, v_lot_number, v_business_id,
           v_organization_id, v_branch_id
    FROM public.stock_lots l
    WHERE l.id = NEW.lot_id;

    v_warehouse_id := NEW.warehouse_id;
    IF v_warehouse_id IS NULL OR v_product_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT id INTO v_storage_loc
      FROM public.stock_locations
      WHERE warehouse_id = v_warehouse_id AND is_default
      LIMIT 1;

    SELECT id INTO v_quarantine_loc
      FROM public.stock_locations
      WHERE warehouse_id = v_warehouse_id AND location_type = 'quarantine'
      LIMIT 1;

    IF v_storage_loc IS NULL OR v_quarantine_loc IS NULL THEN
      RETURN NEW;
    END IF;

    -- Quantity: on-hand at storage for this (product, warehouse, lot).
    -- Prefer quants (Phase 2+); fall back to warehouse_stock_lots.
    SELECT COALESCE(SUM(q.quantity), 0) INTO v_qty
    FROM public.stock_quants q
    WHERE q.product_id = v_product_id
      AND q.location_id = CASE WHEN NEW.status = 'quarantined'
                                 THEN v_storage_loc
                               ELSE v_quarantine_loc END
      AND (q.lot_number IS NOT DISTINCT FROM v_lot_number);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity,
      reference_type, reference_id,
      lot_number,
      source_location_id, destination_location_id,
      movement_date, notes, is_sample_data
    ) VALUES (
      v_organization_id, v_business_id, COALESCE(v_branch_id, (SELECT branch_id FROM public.warehouses WHERE id = v_warehouse_id)),
      v_warehouse_id,
      v_product_id,
      CASE WHEN NEW.status = 'quarantined' THEN 'quarantine_hold'
           ELSE 'quarantine_release' END,
      v_qty,
      'lot_quarantine', NEW.id,
      v_lot_number,
      CASE WHEN NEW.status = 'quarantined' THEN v_storage_loc ELSE v_quarantine_loc END,
      CASE WHEN NEW.status = 'quarantined' THEN v_quarantine_loc ELSE v_storage_loc END,
      now(),
      CASE WHEN NEW.status = 'quarantined'
             THEN 'Auto: QC hold ('||COALESCE(NEW.reason,'')||')'
           ELSE 'Auto: QC release' END,
      false
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot_quarantine_emit_movements ON public.lot_quarantine;
CREATE TRIGGER trg_lot_quarantine_emit_movements
AFTER INSERT OR UPDATE OF status ON public.lot_quarantine
FOR EACH ROW EXECUTE FUNCTION public._emit_quarantine_movements();

COMMENT ON FUNCTION public._emit_quarantine_movements() IS
  'Phase 4 (ADR 0065): on QC hold/release, emits stock movements that '
  'move on-hand between the warehouse default storage location and its '
  'quarantine location. Quant maintenance is handled by the Phase 2 trigger.';
