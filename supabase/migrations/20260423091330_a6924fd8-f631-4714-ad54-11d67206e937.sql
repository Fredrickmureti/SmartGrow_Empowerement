CREATE OR REPLACE FUNCTION public.guard_products_stock_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'products.stock_quantity is a derived aggregate of warehouse_stock and cannot be written directly. Use a stock_adjustment (opening / count / adjustment) against a specific warehouse.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_products_stock_quantity_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.stock_quantity, 0) <> 0 AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'products.stock_quantity must be 0 on INSERT. Record opening stock via a stock_adjustment against a specific warehouse.';
  END IF;
  NEW.stock_quantity := COALESCE(NEW.stock_quantity, 0);
  RETURN NEW;
END;
$$;