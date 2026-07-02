-- ADR 0035 defence-in-depth: lock `factor_to_reference` and `category_id`
-- on a units_of_measure row while it is the `base_uom_id` of any
-- product with the same history footprint guarded by
-- `enforce_base_uom_immutable`. Cosmetic columns stay editable.

CREATE OR REPLACE FUNCTION public.enforce_uom_immutable_when_in_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_factor_changed   boolean;
  v_category_changed boolean;
  v_blocking_product uuid;
  v_blocking_source  text;
BEGIN
  v_factor_changed   := NEW.factor_to_reference IS DISTINCT FROM OLD.factor_to_reference;
  v_category_changed := NEW.category_id        IS DISTINCT FROM OLD.category_id;

  IF NOT (v_factor_changed OR v_category_changed) THEN
    RETURN NEW;
  END IF;

  -- Find the first transacted product that uses this UoM as its base.
  -- We deliberately mirror the probe set of enforce_base_uom_immutable
  -- so the two guards stay aligned.
  WITH probes AS (
    SELECT p.id AS product_id, t.src
    FROM public.products p
    JOIN LATERAL (
      VALUES
        ((SELECT 1 FROM public.stock_movements      WHERE product_id = p.id LIMIT 1), 'stock_movements'),
        ((SELECT 1 FROM public.cost_layers          WHERE product_id = p.id LIMIT 1), 'cost_layers'),
        ((SELECT 1 FROM public.warehouse_stock      WHERE product_id = p.id AND COALESCE(quantity,0) <> 0 LIMIT 1), 'warehouse_stock'),
        ((SELECT 1 FROM public.invoice_items        WHERE product_id = p.id LIMIT 1), 'invoice_items'),
        ((SELECT 1 FROM public.bill_items           WHERE product_id = p.id LIMIT 1), 'bill_items'),
        ((SELECT 1 FROM public.purchase_order_items WHERE product_id = p.id LIMIT 1), 'purchase_order_items'),
        ((SELECT 1 FROM public.sales_order_items    WHERE product_id = p.id LIMIT 1), 'sales_order_items'),
        ((SELECT 1 FROM public.goods_receipt_items  WHERE product_id = p.id LIMIT 1), 'goods_receipt_items'),
        ((SELECT 1 FROM public.pos_transaction_items WHERE product_id = p.id LIMIT 1), 'pos_transaction_items'),
        ((SELECT 1 FROM public.stock_adjustment_items WHERE product_id = p.id LIMIT 1), 'stock_adjustment_items'),
        ((SELECT 1 FROM public.stock_transfer_items WHERE product_id = p.id LIMIT 1), 'stock_transfer_items'),
        ((SELECT 1 FROM public.delivery_note_items  WHERE product_id = p.id LIMIT 1), 'delivery_note_items'),
        ((SELECT 1 FROM public.credit_note_items    WHERE product_id = p.id LIMIT 1), 'credit_note_items')
    ) AS t(hit, src) ON t.hit IS NOT NULL
    WHERE p.base_uom_id = NEW.id
  )
  SELECT product_id, src
    INTO v_blocking_product, v_blocking_source
  FROM probes
  LIMIT 1;

  IF v_blocking_product IS NOT NULL THEN
    IF v_factor_changed THEN
      RAISE EXCEPTION
        'UOM_FACTOR_LOCKED: unit % is the inventory unit of transacted product % (has row in %); factor_to_reference cannot be changed.',
        NEW.id, v_blocking_product, v_blocking_source
        USING ERRCODE = 'P0001';
    END IF;
    IF v_category_changed THEN
      RAISE EXCEPTION
        'UOM_CATEGORY_LOCKED: unit % is the inventory unit of transacted product % (has row in %); category_id cannot be changed.',
        NEW.id, v_blocking_product, v_blocking_source
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_uom_immutable_when_in_use ON public.units_of_measure;
CREATE TRIGGER enforce_uom_immutable_when_in_use
  BEFORE UPDATE OF factor_to_reference, category_id ON public.units_of_measure
  FOR EACH ROW EXECUTE FUNCTION public.enforce_uom_immutable_when_in_use();
