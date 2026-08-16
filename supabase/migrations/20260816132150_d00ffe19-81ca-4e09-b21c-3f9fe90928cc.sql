-- After an inbound transfer leg inherits its cost, the destination warehouse's
-- average cost must be re-derived from the surviving layers; otherwise stock
-- arrives showing no unit cost until an unrelated costing event runs.
-- inventory_sync_avco_from_layers is the registered valuation writer (ADR 0078).
CREATE OR REPLACE FUNCTION public._maintain_cost_layers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_remaining numeric; v_take numeric; v_layer RECORD; v_qty_abs numeric;
  v_child uuid; v_cons RECORD; v_inherited numeric;
BEGIN
  v_qty_abs := abs(NEW.quantity);
  IF v_qty_abs = 0 OR NEW.product_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.movement_type::text IN ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return')
     OR (NEW.movement_type::text = 'adjustment' AND NEW.quantity > 0) THEN
    INSERT INTO public.cost_layers (
      organization_id, business_id, warehouse_id, product_id,
      source_movement_id, received_at, qty_total, qty_remaining,
      unit_cost, source_uom_id, lot_number, serial_number
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id,
      NEW.id, COALESCE(NEW.movement_date, NEW.created_at, now()),
      v_qty_abs, v_qty_abs, COALESCE(NEW.unit_cost, 0), NEW.source_uom_id,
      NEW.lot_number, NEW.serial_number
    )
    RETURNING id INTO v_child;

    -- Layer lineage: an inbound transfer leg inherits from the outbound leg's
    -- consumed layers, so valuation adjustments can follow stock across
    -- warehouses (source -> in-transit -> destination).
    IF NEW.reference_type = 'stock_transfer' AND NEW.reference_id IS NOT NULL THEN
      v_remaining := v_qty_abs;
      FOR v_cons IN
        SELECT c.id, c.layer_id,
               c.qty_consumed - COALESCE((
                 SELECT SUM(l.qty) FROM public.cost_layer_lineage l
                  WHERE l.consumption_id = c.id), 0) AS qty_free
          FROM public.cost_layer_consumptions c
          JOIN public.stock_movements m ON m.id = c.movement_id
         WHERE m.reference_type = 'stock_transfer'
           AND m.reference_id = NEW.reference_id
           AND c.product_id = NEW.product_id
           AND c.business_id = NEW.business_id
           AND (NEW.lot_number IS NULL OR m.lot_number IS NOT DISTINCT FROM NEW.lot_number)
         ORDER BY c.consumed_at, c.id
      LOOP
        EXIT WHEN v_remaining <= 0;
        IF v_cons.qty_free IS NULL OR v_cons.qty_free <= 0 THEN CONTINUE; END IF;
        v_take := LEAST(v_cons.qty_free, v_remaining);
        INSERT INTO public.cost_layer_lineage (
          organization_id, business_id, child_layer_id, parent_layer_id,
          consumption_id, movement_id, qty
        ) VALUES (
          NEW.organization_id, NEW.business_id, v_child, v_cons.layer_id,
          v_cons.id, NEW.id, v_take
        );
        v_remaining := v_remaining - v_take;
      END LOOP;

      -- The transfer engines do not stamp a unit cost on the movement legs.
      -- Carry the cost of the exact stock that moved, weighted by traced
      -- quantity, so transferring stock never destroys inventory value.
      IF COALESCE(NEW.unit_cost, 0) = 0 THEN
        SELECT SUM(l.qty * c.unit_cost) / NULLIF(SUM(l.qty), 0)
          INTO v_inherited
          FROM public.cost_layer_lineage l
          JOIN public.cost_layer_consumptions c ON c.id = l.consumption_id
         WHERE l.child_layer_id = v_child;

        IF v_inherited IS NOT NULL AND v_inherited <> 0 THEN
          UPDATE public.cost_layers SET unit_cost = v_inherited WHERE id = v_child;
        END IF;
      END IF;

      PERFORM public.inventory_sync_avco_from_layers(
        NEW.business_id, NEW.product_id, NEW.warehouse_id);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.movement_type::text IN ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return')
     OR (NEW.movement_type::text = 'adjustment' AND NEW.quantity < 0) THEN
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
END;
$function$;