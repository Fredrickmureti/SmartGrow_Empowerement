
-- Goods Receipts table for tracking receiving against POs
CREATE TABLE public.goods_receipts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  business_id UUID REFERENCES public.businesses(id),
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL,
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  received_by UUID REFERENCES auth.users(id),
  warehouse_id UUID REFERENCES public.warehouses(id),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('draft', 'completed', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Goods Receipt Items
CREATE TABLE public.goods_receipt_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  goods_receipt_id UUID NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  purchase_order_item_id UUID REFERENCES public.purchase_order_items(id),
  product_id UUID REFERENCES public.products(id),
  description TEXT NOT NULL,
  quantity_ordered NUMERIC NOT NULL DEFAULT 0,
  quantity_received NUMERIC NOT NULL DEFAULT 0,
  lot_number TEXT,
  serial_number TEXT,
  notes TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add receipt_status to purchase_order_items if not exists
ALTER TABLE public.purchase_order_items 
  ADD COLUMN IF NOT EXISTS receipt_status TEXT NOT NULL DEFAULT 'pending';

-- Enable RLS
ALTER TABLE public.goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods_receipt_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for goods_receipts
CREATE POLICY "Users can view goods receipts in their org"
  ON public.goods_receipts FOR SELECT
  USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can create goods receipts in their org"
  ON public.goods_receipts FOR INSERT
  WITH CHECK (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can update goods receipts in their org"
  ON public.goods_receipts FOR UPDATE
  USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can delete goods receipts in their org"
  ON public.goods_receipts FOR DELETE
  USING (is_org_member(auth.uid(), organization_id));

-- RLS policies for goods_receipt_items
CREATE POLICY "Users can view goods receipt items"
  ON public.goods_receipt_items FOR SELECT
  USING (goods_receipt_id IN (
    SELECT gr.id FROM public.goods_receipts gr
    WHERE is_org_member(auth.uid(), gr.organization_id)
  ));

CREATE POLICY "Users can create goods receipt items"
  ON public.goods_receipt_items FOR INSERT
  WITH CHECK (goods_receipt_id IN (
    SELECT gr.id FROM public.goods_receipts gr
    WHERE is_org_member(auth.uid(), gr.organization_id)
  ));

CREATE POLICY "Users can update goods receipt items"
  ON public.goods_receipt_items FOR UPDATE
  USING (goods_receipt_id IN (
    SELECT gr.id FROM public.goods_receipts gr
    WHERE is_org_member(auth.uid(), gr.organization_id)
  ));

CREATE POLICY "Users can delete goods receipt items"
  ON public.goods_receipt_items FOR DELETE
  USING (goods_receipt_id IN (
    SELECT gr.id FROM public.goods_receipts gr
    WHERE is_org_member(auth.uid(), gr.organization_id)
  ));

-- Function to get next GRN number
CREATE OR REPLACE FUNCTION public.get_next_grn_number(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INT;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN receipt_number ~ '^GRN-[0-9]+$'
    THEN CAST(SUBSTRING(receipt_number FROM 5) AS INT)
    ELSE 0 END
  ), 0) + 1
  INTO next_num
  FROM goods_receipts
  WHERE organization_id = _org_id;
  
  RETURN 'GRN-' || LPAD(next_num::TEXT, 5, '0');
END;
$$;

-- Trigger for updated_at
CREATE TRIGGER update_goods_receipts_updated_at
  BEFORE UPDATE ON public.goods_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes for performance
CREATE INDEX idx_goods_receipts_po_id ON public.goods_receipts(purchase_order_id);
CREATE INDEX idx_goods_receipts_org_id ON public.goods_receipts(organization_id);
CREATE INDEX idx_goods_receipt_items_receipt_id ON public.goods_receipt_items(goods_receipt_id);
