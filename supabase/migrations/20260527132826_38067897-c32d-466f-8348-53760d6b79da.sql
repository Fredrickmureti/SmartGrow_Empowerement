
CREATE OR REPLACE FUNCTION public._uom_normalize_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_base_uom uuid; v_pack_qty numeric;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty FROM public.product_packaging WHERE id = NEW.packaging_id;
    IF v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
      IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity / v_pack_qty; END IF;
      NEW.quantity := NEW.display_quantity * v_pack_qty;
      IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.display_uom_id IS NOT NULL AND NEW.display_quantity IS NOT NULL THEN
    IF NEW.display_uom_id = v_base_uom THEN
      NEW.quantity := NEW.display_quantity;
    ELSE
      NEW.quantity := public.convert_uom(NEW.display_quantity, NEW.display_uom_id, v_base_uom);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
  IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public._uom_normalize_line_grn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_base_uom uuid; v_pack_qty numeric;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT qty_in_base_uom INTO v_pack_qty FROM public.product_packaging WHERE id = NEW.packaging_id;
    IF v_pack_qty IS NOT NULL AND v_pack_qty > 0 THEN
      IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_received / v_pack_qty; END IF;
      NEW.quantity_received := NEW.display_quantity * v_pack_qty;
      IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.display_uom_id IS NOT NULL AND NEW.display_quantity IS NOT NULL THEN
    IF NEW.display_uom_id = v_base_uom THEN
      NEW.quantity_received := NEW.display_quantity;
    ELSE
      NEW.quantity_received := public.convert_uom(NEW.display_quantity, NEW.display_uom_id, v_base_uom);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
  IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_received; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_uom_normalize_invoice_items ON public.invoice_items;
CREATE TRIGGER trg_uom_normalize_invoice_items BEFORE INSERT OR UPDATE ON public.invoice_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_sales_order_items ON public.sales_order_items;
CREATE TRIGGER trg_uom_normalize_sales_order_items BEFORE INSERT OR UPDATE ON public.sales_order_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_po_items ON public.purchase_order_items;
CREATE TRIGGER trg_uom_normalize_po_items BEFORE INSERT OR UPDATE ON public.purchase_order_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_pos_items ON public.pos_transaction_items;
CREATE TRIGGER trg_uom_normalize_pos_items BEFORE INSERT OR UPDATE ON public.pos_transaction_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_adj_items ON public.stock_adjustment_items;
CREATE TRIGGER trg_uom_normalize_adj_items BEFORE INSERT OR UPDATE ON public.stock_adjustment_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_xfer_items ON public.stock_transfer_items;
CREATE TRIGGER trg_uom_normalize_xfer_items BEFORE INSERT OR UPDATE ON public.stock_transfer_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_grn_items ON public.goods_receipt_items;
CREATE TRIGGER trg_uom_normalize_grn_items BEFORE INSERT OR UPDATE ON public.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line_grn();

CREATE OR REPLACE FUNCTION public._stamp_default_movement_uom()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.source_uom_id IS NULL AND NEW.product_id IS NOT NULL THEN
    SELECT base_uom_id INTO NEW.source_uom_id FROM public.products WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_stamp_default_movement_uom ON public.stock_movements;
CREATE TRIGGER trg_stamp_default_movement_uom BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._stamp_default_movement_uom();

-- ============ Phase 5: FIFO Cost Layers ============
CREATE TABLE IF NOT EXISTS public.cost_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid,
  product_id uuid NOT NULL,
  source_movement_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  qty_total numeric NOT NULL CHECK (qty_total > 0),
  qty_remaining numeric NOT NULL CHECK (qty_remaining >= 0),
  unit_cost numeric NOT NULL DEFAULT 0,
  source_uom_id uuid,
  lot_number text,
  serial_number text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_layers_fifo
  ON public.cost_layers (business_id, product_id, warehouse_id, received_at)
  WHERE qty_remaining > 0;
CREATE INDEX IF NOT EXISTS idx_cost_layers_movement ON public.cost_layers (source_movement_id);

GRANT SELECT ON public.cost_layers TO authenticated;
GRANT ALL ON public.cost_layers TO service_role;
ALTER TABLE public.cost_layers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read cost layers" ON public.cost_layers FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE TABLE IF NOT EXISTS public.cost_layer_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  layer_id uuid NOT NULL REFERENCES public.cost_layers(id) ON DELETE RESTRICT,
  movement_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty_consumed numeric NOT NULL CHECK (qty_consumed > 0),
  unit_cost numeric NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clc_layer ON public.cost_layer_consumptions (layer_id);
CREATE INDEX IF NOT EXISTS idx_clc_movement ON public.cost_layer_consumptions (movement_id);

GRANT SELECT ON public.cost_layer_consumptions TO authenticated;
GRANT ALL ON public.cost_layer_consumptions TO service_role;
ALTER TABLE public.cost_layer_consumptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members read cost consumptions" ON public.cost_layer_consumptions FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public._maintain_cost_layers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_remaining numeric; v_take numeric; v_layer RECORD; v_qty_abs numeric;
BEGIN
  v_qty_abs := abs(NEW.quantity);
  IF v_qty_abs = 0 OR NEW.product_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.movement_type::text IN ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return') THEN
    INSERT INTO public.cost_layers (
      organization_id, business_id, warehouse_id, product_id,
      source_movement_id, received_at, qty_total, qty_remaining,
      unit_cost, source_uom_id, lot_number, serial_number
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id,
      NEW.id, COALESCE(NEW.movement_date, NEW.created_at, now()),
      v_qty_abs, v_qty_abs, COALESCE(NEW.unit_cost, 0), NEW.source_uom_id,
      NEW.lot_number, NEW.serial_number
    );
    RETURN NEW;
  END IF;

  IF NEW.movement_type::text IN ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return') THEN
    v_remaining := v_qty_abs;
    FOR v_layer IN
      SELECT id, qty_remaining, unit_cost FROM public.cost_layers
       WHERE business_id = NEW.business_id AND product_id = NEW.product_id
         AND (NEW.warehouse_id IS NULL OR warehouse_id IS NULL OR warehouse_id = NEW.warehouse_id)
         AND qty_remaining > 0
       ORDER BY received_at, created_at FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_layer.qty_remaining, v_remaining);
      UPDATE public.cost_layers SET qty_remaining = qty_remaining - v_take WHERE id = v_layer.id;
      INSERT INTO public.cost_layer_consumptions (
        organization_id, business_id, layer_id, movement_id, product_id, qty_consumed, unit_cost
      ) VALUES (
        NEW.organization_id, NEW.business_id, v_layer.id, NEW.id, NEW.product_id, v_take, v_layer.unit_cost
      );
      v_remaining := v_remaining - v_take;
    END LOOP;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_maintain_cost_layers ON public.stock_movements;
CREATE TRIGGER trg_maintain_cost_layers AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._maintain_cost_layers();

-- Backfill historical receipts
DO $backfill$
DECLARE v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT sm.* FROM public.stock_movements sm
     WHERE sm.movement_type::text IN ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return')
       AND NOT EXISTS (SELECT 1 FROM public.cost_layers cl WHERE cl.source_movement_id = sm.id)
     ORDER BY sm.movement_date, sm.created_at
  LOOP
    INSERT INTO public.cost_layers (
      organization_id, business_id, warehouse_id, product_id,
      source_movement_id, received_at, qty_total, qty_remaining,
      unit_cost, source_uom_id, lot_number, serial_number
    ) VALUES (
      v_rec.organization_id, v_rec.business_id, v_rec.warehouse_id, v_rec.product_id,
      v_rec.id, COALESCE(v_rec.movement_date, v_rec.created_at, now()),
      abs(v_rec.quantity), abs(v_rec.quantity), COALESCE(v_rec.unit_cost, 0), v_rec.source_uom_id,
      v_rec.lot_number, v_rec.serial_number
    );
  END LOOP;
END; $backfill$;

CREATE OR REPLACE VIEW public.v_cost_layer_basis AS
SELECT business_id, product_id, warehouse_id,
  SUM(qty_remaining) AS qty_on_hand,
  SUM(qty_remaining * unit_cost) AS inventory_value,
  CASE WHEN SUM(qty_remaining) > 0 THEN SUM(qty_remaining * unit_cost)/SUM(qty_remaining) ELSE 0 END AS fifo_unit_cost
FROM public.cost_layers WHERE qty_remaining > 0
GROUP BY business_id, product_id, warehouse_id;

GRANT SELECT ON public.v_cost_layer_basis TO authenticated;

COMMENT ON TABLE public.cost_layers IS 'FIFO cost layer ledger — one row per receipt; qty_remaining drained FIFO on outbound movements.';
COMMENT ON TABLE public.cost_layer_consumptions IS 'Audit trail: which outbound movement consumed which layer at what cost.';
