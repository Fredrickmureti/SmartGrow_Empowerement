
-- WMS Phase 0: warehouse layout structure columns on stock_locations.
-- Additive only. Existing default-per-warehouse rows unaffected.

ALTER TABLE public.stock_locations
  ADD COLUMN IF NOT EXISTS structure_level text
    CHECK (structure_level IS NULL OR structure_level IN ('zone','aisle','rack','shelf','bin','dock','staging_in','staging_out')),
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS capacity_max_units numeric,
  ADD COLUMN IF NOT EXISTS capacity_max_weight numeric,
  ADD COLUMN IF NOT EXISTS pick_sequence integer;

-- Barcodes unique per warehouse where set.
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_warehouse_barcode_unique
  ON public.stock_locations (warehouse_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_locations_warehouse_parent_idx
  ON public.stock_locations (warehouse_id, parent_location_id);

COMMENT ON COLUMN public.stock_locations.structure_level IS
  'WMS layout hierarchy level: zone > aisle > rack > shelf > bin (+dock, staging_in, staging_out). NULL means legacy default/virtual location. See ADR 0079.';
COMMENT ON COLUMN public.stock_locations.barcode IS 'Physical location barcode (scan-to-select). Unique per warehouse when set.';
COMMENT ON COLUMN public.stock_locations.pick_sequence IS 'Sort order for pick-path traversal within its parent.';
