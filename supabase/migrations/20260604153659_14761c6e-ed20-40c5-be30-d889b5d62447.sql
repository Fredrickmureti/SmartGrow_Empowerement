
CREATE OR REPLACE FUNCTION public.enforce_base_uom_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_cat uuid;
  v_new_cat uuid;
  v_count   bigint := 0;
  v_source  text   := NULL;
BEGIN
  IF NEW.base_uom_id IS NOT DISTINCT FROM OLD.base_uom_id THEN
    RETURN NEW;
  END IF;

  IF NEW.base_uom_id IS NULL THEN
    RAISE EXCEPTION 'BASE_UOM_LOCKED: base_uom_id cannot be cleared once set'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT category_id INTO v_old_cat FROM public.units_of_measure WHERE id = OLD.base_uom_id;
  SELECT category_id INTO v_new_cat FROM public.units_of_measure WHERE id = NEW.base_uom_id;
  IF v_old_cat IS NOT NULL AND v_new_cat IS DISTINCT FROM v_old_cat THEN
    RAISE EXCEPTION 'BASE_UOM_CATEGORY_CHANGE: new base unit category (%) must match current base unit category (%)',
      v_new_cat, v_old_cat USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_count FROM public.stock_movements WHERE product_id = NEW.id;
  IF v_count > 0 THEN v_source := 'stock_movements'; END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.cost_layers WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'cost_layers'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.warehouse_stock
      WHERE product_id = NEW.id AND COALESCE(quantity, 0) <> 0;
    IF v_count > 0 THEN v_source := 'warehouse_stock'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.invoice_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'invoice_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.bill_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'bill_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.purchase_order_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'purchase_order_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.sales_order_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'sales_order_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.goods_receipt_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'goods_receipt_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.pos_transaction_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'pos_transaction_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.stock_adjustment_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'stock_adjustment_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.stock_transfer_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'stock_transfer_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.delivery_note_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'delivery_note_items'; END IF;
  END IF;
  IF v_source IS NULL THEN
    SELECT count(*) INTO v_count FROM public.credit_note_items WHERE product_id = NEW.id;
    IF v_count > 0 THEN v_source := 'credit_note_items'; END IF;
  END IF;

  IF v_source IS NOT NULL THEN
    RAISE EXCEPTION
      'BASE_UOM_LOCKED: product has % row(s) in %; inventory unit cannot be changed. Use Packaging to buy/sell in a different unit.',
      v_count, v_source
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_base_uom_immutable ON public.products;
CREATE TRIGGER enforce_base_uom_immutable
  BEFORE UPDATE OF base_uom_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_base_uom_immutable();

-- Phase E: one-shot remediation. Update both sibling columns in a single
-- statement so enforce_product_uom_category sees a consistent NEW row.
WITH bad AS (
  SELECT p.id, p.base_uom_id
  FROM public.products p
  LEFT JOIN public.units_of_measure b  ON b.id  = p.base_uom_id
  LEFT JOIN public.units_of_measure s  ON s.id  = p.sales_uom_id
  LEFT JOIN public.units_of_measure pu ON pu.id = p.purchase_uom_id
  WHERE p.base_uom_id IS NOT NULL
    AND (
      (p.sales_uom_id    IS NOT NULL AND s.category_id  IS DISTINCT FROM b.category_id) OR
      (p.purchase_uom_id IS NOT NULL AND pu.category_id IS DISTINCT FROM b.category_id)
    )
)
UPDATE public.products p
SET sales_uom_id    = bad.base_uom_id,
    purchase_uom_id = bad.base_uom_id
FROM bad
WHERE p.id = bad.id;
