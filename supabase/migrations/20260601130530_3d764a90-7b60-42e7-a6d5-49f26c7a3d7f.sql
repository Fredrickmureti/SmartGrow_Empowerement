-- Add the missing UoM/packaging columns to delivery_note_items so the
-- `_backfill_movement_packaging` trigger on stock_movements can resolve
-- packaging + display UoM during delivery completion. The same shape is
-- already present on every other line-item table in the system.
ALTER TABLE public.delivery_note_items
  ADD COLUMN IF NOT EXISTS packaging_id   uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS display_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS display_quantity numeric;