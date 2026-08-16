-- P0-3: inbound_shipment_items had no UOM normalizer, unlike stock_movements
-- (_stamp_ledger_uom_snapshot / _enforce_movement_uom_granularity). An ASN line
-- could carry an unconverted pack quantity in expected_quantity, so the
-- warehouse expectation disagreed with the base-unit ledger.
-- expected_quantity is BASE units; display_quantity is the operator-entered
-- pack figure. Conversion goes through the single authority wms_to_base_qty.
CREATE OR REPLACE FUNCTION public._normalize_inbound_shipment_item_uom()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_base   numeric;
  v_factor numeric;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.expected_packaging_id IS NOT NULL THEN
    SELECT pp.qty_in_base_uom INTO v_factor
      FROM public.product_packaging pp
     WHERE pp.id = NEW.expected_packaging_id
       AND pp.product_id = NEW.product_id;
    IF v_factor IS NULL THEN
      RAISE EXCEPTION
        'ASN_PACKAGING_MISMATCH: packaging % does not belong to product %',
        NEW.expected_packaging_id, NEW.product_id USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.display_quantity IS NOT NULL AND NEW.expected_packaging_id IS NOT NULL THEN
    v_base := public.wms_to_base_qty(
      NEW.product_id, NEW.expected_packaging_id, NEW.display_quantity
    );

    IF NEW.expected_quantity IS NULL THEN
      NEW.expected_quantity := v_base;
    ELSIF abs(NEW.expected_quantity - v_base) > 0.000001 THEN
      RAISE EXCEPTION
        'ASN_UOM_CONFLICT: expected_quantity % contradicts % x packaging factor % = % base units',
        NEW.expected_quantity, NEW.display_quantity, v_factor, v_base
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Mirror the ledger snapshot behaviour: derive the pack figure when only the
  -- base quantity was supplied, so every surface can render cartons.
  IF NEW.display_quantity IS NULL
     AND NEW.expected_quantity IS NOT NULL
     AND COALESCE(v_factor, 0) > 0 THEN
    NEW.display_quantity := round(NEW.expected_quantity / v_factor, 6);
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_normalize_inbound_shipment_item_uom ON public.inbound_shipment_items;
CREATE TRIGGER trg_normalize_inbound_shipment_item_uom
BEFORE INSERT OR UPDATE ON public.inbound_shipment_items
FOR EACH ROW EXECUTE FUNCTION public._normalize_inbound_shipment_item_uom();