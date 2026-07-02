-- Multi-unit pack provenance columns on remaining transaction-line tables.
-- Matches the shape already present on pos_transaction_items, invoice_items,
-- sales_order_items, purchase_order_items, goods_receipt_items, delivery_note_items.

ALTER TABLE public.estimate_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid NULL REFERENCES public.units_of_measure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS uom_snapshot text NULL;

ALTER TABLE public.bill_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid NULL REFERENCES public.units_of_measure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS uom_snapshot text NULL;

ALTER TABLE public.credit_note_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid NULL REFERENCES public.units_of_measure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS uom_snapshot text NULL;

ALTER TABLE public.sales_return_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid NULL REFERENCES public.units_of_measure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS uom_snapshot text NULL;

ALTER TABLE public.purchase_return_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid NULL REFERENCES public.product_packaging(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid NULL REFERENCES public.units_of_measure(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_quantity numeric NULL,
  ADD COLUMN IF NOT EXISTS uom_snapshot text NULL;

-- Indexes only where we expect to filter/join by packaging_id
CREATE INDEX IF NOT EXISTS idx_estimate_items_packaging_id     ON public.estimate_items(packaging_id)     WHERE packaging_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_items_packaging_id         ON public.bill_items(packaging_id)         WHERE packaging_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_note_items_packaging_id  ON public.credit_note_items(packaging_id)  WHERE packaging_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_return_items_packaging_id ON public.sales_return_items(packaging_id) WHERE packaging_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_pkg_id    ON public.purchase_return_items(packaging_id) WHERE packaging_id IS NOT NULL;

-- Shared conversion helper for display→base quantity normalization.
CREATE OR REPLACE FUNCTION public.normalize_display_to_base(
  p_display numeric,
  p_packaging_id uuid
) RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    p_display * COALESCE((SELECT pp.qty_in_base_uom FROM public.product_packaging pp WHERE pp.id = p_packaging_id), 1),
    p_display
  );
$$;

GRANT EXECUTE ON FUNCTION public.normalize_display_to_base(numeric, uuid) TO authenticated, anon, service_role;