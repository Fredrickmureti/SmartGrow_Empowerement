-- Phase 3: Add MOQ (Minimum Order Quantity) fields to products
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS min_order_quantity NUMERIC DEFAULT 1,
ADD COLUMN IF NOT EXISTS order_quantity_increment NUMERIC DEFAULT 1;

-- Add comments for documentation
COMMENT ON COLUMN public.products.min_order_quantity IS 'Minimum quantity that must be ordered for this product';
COMMENT ON COLUMN public.products.order_quantity_increment IS 'Quantity must be ordered in multiples of this value (e.g., case of 12)';