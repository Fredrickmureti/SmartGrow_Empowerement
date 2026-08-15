-- ---------------------------------------------------------------------------
-- Phase 3 (cont.): one quantity contract across every sales line table.
-- ---------------------------------------------------------------------------

-- 1. Proforma lines were missing the customer-unit provenance columns.
ALTER TABLE public.proforma_invoice_items
  ADD COLUMN IF NOT EXISTS display_quantity numeric(15,4),
  ADD COLUMN IF NOT EXISTS display_uom_id   uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS packaging_id     uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS uom_snapshot     text;

ALTER TABLE public.proforma_invoice_items ALTER COLUMN quantity TYPE numeric(15,4);

-- 2. Attach the canonical normalizer to the remaining sales line tables.
DROP TRIGGER IF EXISTS trg_uom_normalize_estimate_items ON public.estimate_items;
CREATE TRIGGER trg_uom_normalize_estimate_items
  BEFORE INSERT OR UPDATE ON public.estimate_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_credit_note_items ON public.credit_note_items;
CREATE TRIGGER trg_uom_normalize_credit_note_items
  BEFORE INSERT OR UPDATE ON public.credit_note_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_sales_return_items ON public.sales_return_items;
CREATE TRIGGER trg_uom_normalize_sales_return_items
  BEFORE INSERT OR UPDATE ON public.sales_return_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS trg_uom_normalize_proforma_items ON public.proforma_invoice_items;
CREATE TRIGGER trg_uom_normalize_proforma_items
  BEFORE INSERT OR UPDATE ON public.proforma_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

-- 3. Delivery lines carry no plain `quantity`; their ordered/delivered figures
--    are already base units resolved from the sales order. Record the customer
--    unit for the printed document without touching those figures.
CREATE OR REPLACE FUNCTION public._uom_stamp_delivery_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom uuid;
  v_pack_qty numeric;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  IF NEW.packaging_id IS NOT NULL THEN
    SELECT pk.qty_in_base_uom INTO v_pack_qty
      FROM public.product_packaging pk
     WHERE pk.id = NEW.packaging_id AND pk.product_id = NEW.product_id;
    IF v_pack_qty IS NULL THEN
      RAISE EXCEPTION 'delivery line: packaging % does not belong to product %',
        NEW.packaging_id, NEW.product_id;
    END IF;
  END IF;

  IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;

  IF NEW.display_quantity IS NULL THEN
    NEW.display_quantity := CASE
      WHEN v_pack_qty IS NOT NULL AND v_pack_qty > 0
        THEN NEW.quantity_delivered / v_pack_qty
      ELSE NEW.quantity_delivered
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_uom_stamp_delivery_note_items ON public.delivery_note_items;
CREATE TRIGGER trg_uom_stamp_delivery_note_items
  BEFORE INSERT OR UPDATE ON public.delivery_note_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_stamp_delivery_line();

-- 4. Declare the contract in the schema itself.
COMMENT ON COLUMN public.sales_order_items.quantity     IS 'Base (stocking) units. Derived server-side from display_quantity + display_uom_id | packaging_id by _uom_normalize_line → resolve_line_base_quantity. Never trust a client-supplied value.';
COMMENT ON COLUMN public.invoice_items.quantity         IS 'Base (stocking) units. Derived server-side by _uom_normalize_line → resolve_line_base_quantity.';
COMMENT ON COLUMN public.estimate_items.quantity        IS 'Base (stocking) units. Derived server-side by _uom_normalize_line → resolve_line_base_quantity.';
COMMENT ON COLUMN public.credit_note_items.quantity     IS 'Base (stocking) units. Derived server-side by _uom_normalize_line → resolve_line_base_quantity.';
COMMENT ON COLUMN public.sales_return_items.quantity    IS 'Base (stocking) units. Derived server-side by _uom_normalize_line → resolve_line_base_quantity.';
COMMENT ON COLUMN public.proforma_invoice_items.quantity IS 'Base (stocking) units. Derived server-side by _uom_normalize_line → resolve_line_base_quantity.';
COMMENT ON COLUMN public.delivery_note_items.quantity_delivered IS 'Base (stocking) units, resolved from the sales order line. display_quantity / display_uom_id / packaging_id record the customer unit for the printed document.';
COMMENT ON COLUMN public.delivery_note_items.quantity_ordered   IS 'Base (stocking) units, copied from the sales order line.';