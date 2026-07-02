-- Add source_purchase_order_id to bills for bill→PO back-reference traceability
ALTER TABLE public.bills 
ADD COLUMN IF NOT EXISTS source_purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_bills_source_po_id ON public.bills(source_purchase_order_id) WHERE source_purchase_order_id IS NOT NULL;

-- Backfill existing converted bills from purchase_orders.converted_bill_id
UPDATE public.bills b
SET source_purchase_order_id = po.id
FROM public.purchase_orders po
WHERE po.converted_bill_id = b.id
  AND b.source_purchase_order_id IS NULL;