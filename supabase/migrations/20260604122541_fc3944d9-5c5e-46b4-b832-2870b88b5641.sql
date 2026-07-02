ALTER TABLE public.vendor_credit_note_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS display_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS display_quantity numeric,
  ADD COLUMN IF NOT EXISTS uom_snapshot text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_vendor_credit_note_items_packaging_id ON public.vendor_credit_note_items(packaging_id);