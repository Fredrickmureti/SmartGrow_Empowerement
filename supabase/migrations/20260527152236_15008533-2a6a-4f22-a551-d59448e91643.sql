-- UoM & Packaging — Re-audit Patch (2026-06-08)
-- R8 — UPDATE-idempotency guard
CREATE OR REPLACE FUNCTION public._uom_normalize_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_base_uom uuid; v_pack_qty numeric; v_should_renorm boolean;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  v_should_renorm := (TG_OP = 'INSERT') OR (
    NEW.packaging_id IS DISTINCT FROM OLD.packaging_id
    OR NEW.display_quantity IS DISTINCT FROM OLD.display_quantity
    OR NEW.display_uom_id IS DISTINCT FROM OLD.display_uom_id
  );

  IF NOT v_should_renorm THEN
    IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity; END IF;
    RETURN NEW;
  END IF;

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
DECLARE v_base_uom uuid; v_pack_qty numeric; v_should_renorm boolean;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = NEW.product_id;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  v_should_renorm := (TG_OP = 'INSERT') OR (
    NEW.packaging_id IS DISTINCT FROM OLD.packaging_id
    OR NEW.display_quantity IS DISTINCT FROM OLD.display_quantity
    OR NEW.display_uom_id IS DISTINCT FROM OLD.display_uom_id
  );

  IF NOT v_should_renorm THEN
    IF NEW.display_uom_id IS NULL THEN NEW.display_uom_id := v_base_uom; END IF;
    IF NEW.display_quantity IS NULL THEN NEW.display_quantity := NEW.quantity_received; END IF;
    RETURN NEW;
  END IF;

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

-- R2 — Backfill packaging provenance onto stock_movements
CREATE OR REPLACE FUNCTION public._backfill_movement_packaging()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pkg uuid; v_uom uuid;
BEGIN
  IF NEW.reference_id IS NULL OR NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.source_packaging_id IS NOT NULL AND NEW.source_uom_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  CASE NEW.reference_type
    WHEN 'invoice' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom
        FROM public.invoice_items
       WHERE invoice_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST
       LIMIT 1;
    WHEN 'delivery_note' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom
        FROM public.delivery_note_items
       WHERE delivery_note_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST
       LIMIT 1;
    WHEN 'goods_receipt' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom
        FROM public.goods_receipt_items
       WHERE goods_receipt_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST
       LIMIT 1;
    WHEN 'stock_adjustment' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom
        FROM public.stock_adjustment_items
       WHERE adjustment_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST
       LIMIT 1;
    WHEN 'stock_transfer' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom
        FROM public.stock_transfer_items
       WHERE transfer_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST
       LIMIT 1;
    ELSE
      RETURN NEW;
  END CASE;

  IF v_pkg IS NULL AND v_uom IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.stock_movements
     SET source_packaging_id = COALESCE(source_packaging_id, v_pkg),
         source_uom_id       = COALESCE(source_uom_id, v_uom)
   WHERE id = NEW.id
     AND (source_packaging_id IS NULL OR source_uom_id IS NULL);

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_backfill_movement_packaging ON public.stock_movements;
CREATE TRIGGER trg_backfill_movement_packaging
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public._backfill_movement_packaging();

-- Whitelist provenance back-fill if the immutability trigger exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_stock_movement_immutability'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.enforce_stock_movement_immutability()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF (
            NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
            NEW.business_id     IS DISTINCT FROM OLD.business_id     OR
            NEW.branch_id       IS DISTINCT FROM OLD.branch_id       OR
            NEW.product_id      IS DISTINCT FROM OLD.product_id      OR
            NEW.warehouse_id    IS DISTINCT FROM OLD.warehouse_id    OR
            NEW.movement_type   IS DISTINCT FROM OLD.movement_type   OR
            NEW.quantity        IS DISTINCT FROM OLD.quantity        OR
            NEW.unit_cost       IS DISTINCT FROM OLD.unit_cost       OR
            NEW.reference_type  IS DISTINCT FROM OLD.reference_type  OR
            NEW.reference_id    IS DISTINCT FROM OLD.reference_id    OR
            NEW.movement_date   IS DISTINCT FROM OLD.movement_date
          ) THEN
            RAISE EXCEPTION 'stock_movements rows are immutable except for provenance back-fill';
          END IF;
        ELSIF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'stock_movements rows cannot be deleted';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $body$;
    $f$;
  END IF;
END$$;

-- R4 — compute_unit_cost helper
CREATE OR REPLACE FUNCTION public.compute_unit_cost(
  p_business_id uuid,
  p_product_id  uuid,
  p_warehouse_id uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_model text;
  v_cost numeric;
BEGIN
  IF p_product_id IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(cost_model, 'wac') INTO v_model
    FROM public.businesses WHERE id = p_business_id;

  IF v_model = 'fifo' THEN
    SELECT cl.unit_cost
      INTO v_cost
      FROM public.cost_layers cl
     WHERE cl.business_id = p_business_id
       AND cl.product_id  = p_product_id
       AND cl.qty_remaining > 0
       AND (p_warehouse_id IS NULL
            OR cl.warehouse_id = p_warehouse_id
            OR cl.warehouse_id IS NULL)
     ORDER BY cl.received_at ASC, cl.created_at ASC
     LIMIT 1;

    IF v_cost IS NOT NULL THEN RETURN v_cost; END IF;
  END IF;

  SELECT COALESCE(cost_price, 0) INTO v_cost
    FROM public.products WHERE id = p_product_id;
  RETURN COALESCE(v_cost, 0);
END; $$;

GRANT EXECUTE ON FUNCTION public.compute_unit_cost(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_unit_cost(uuid, uuid, uuid) IS
  'Single read site for unit cost. Branches on businesses.cost_model: fifo -> oldest live cost_layer; wac -> products.cost_price. See ADR 0023.';
