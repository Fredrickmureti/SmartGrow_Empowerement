-- Add warehouse_id to stock_adjustment_items for multi-warehouse adjustments
ALTER TABLE public.stock_adjustment_items 
ADD COLUMN warehouse_id UUID REFERENCES public.warehouses(id);

-- Add index for performance
CREATE INDEX idx_stock_adjustment_items_warehouse ON public.stock_adjustment_items(warehouse_id);