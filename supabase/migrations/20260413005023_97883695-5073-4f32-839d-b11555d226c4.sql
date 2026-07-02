
-- 1. Add unique constraint on warehouse_stock for safe upserts
ALTER TABLE public.warehouse_stock
  ADD CONSTRAINT warehouse_stock_warehouse_product_unique 
  UNIQUE (warehouse_id, product_id);

-- 2. Create helper function: ensure a default warehouse exists for an org
CREATE OR REPLACE FUNCTION public.ensure_default_warehouse(p_organization_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_warehouse_id uuid;
BEGIN
  -- Try to find existing default warehouse
  SELECT id INTO v_warehouse_id
  FROM public.warehouses
  WHERE organization_id = p_organization_id
    AND is_default = true
  LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    RETURN v_warehouse_id;
  END IF;

  -- Try any warehouse
  SELECT id INTO v_warehouse_id
  FROM public.warehouses
  WHERE organization_id = p_organization_id
  LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    -- Mark it as default
    UPDATE public.warehouses SET is_default = true WHERE id = v_warehouse_id;
    RETURN v_warehouse_id;
  END IF;

  -- Create a default warehouse
  INSERT INTO public.warehouses (organization_id, name, code, is_default, is_active)
  VALUES (p_organization_id, 'Main Warehouse', 'MAIN', true, true)
  RETURNING id INTO v_warehouse_id;

  RETURN v_warehouse_id;
END;
$$;

-- 3. Add is_default column to warehouses if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'is_default'
  ) THEN
    ALTER TABLE public.warehouses ADD COLUMN is_default boolean DEFAULT false;
  END IF;
END $$;

-- 4. Replace the update_product_stock trigger function to also upsert warehouse_stock
CREATE OR REPLACE FUNCTION public.update_product_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Update global product stock
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) + NEW.quantity
    WHERE id = NEW.product_id;

    -- Update warehouse stock if warehouse_id is set
    IF NEW.warehouse_id IS NOT NULL THEN
      INSERT INTO public.warehouse_stock (organization_id, warehouse_id, product_id, quantity, reserved_quantity)
      SELECT NEW.organization_id, NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
      ON CONFLICT (warehouse_id, product_id)
      DO UPDATE SET 
        quantity = COALESCE(warehouse_stock.quantity, 0) + NEW.quantity,
        updated_at = now();
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity
    WHERE id = OLD.product_id;

    IF OLD.warehouse_id IS NOT NULL THEN
      UPDATE public.warehouse_stock
      SET quantity = COALESCE(quantity, 0) - OLD.quantity, updated_at = now()
      WHERE warehouse_id = OLD.warehouse_id AND product_id = OLD.product_id;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.products 
    SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity + NEW.quantity
    WHERE id = NEW.product_id;

    -- Handle warehouse changes on update
    IF OLD.warehouse_id IS NOT NULL THEN
      UPDATE public.warehouse_stock
      SET quantity = COALESCE(quantity, 0) - OLD.quantity, updated_at = now()
      WHERE warehouse_id = OLD.warehouse_id AND product_id = OLD.product_id;
    END IF;
    IF NEW.warehouse_id IS NOT NULL THEN
      INSERT INTO public.warehouse_stock (organization_id, warehouse_id, product_id, quantity, reserved_quantity)
      SELECT NEW.organization_id, NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
      ON CONFLICT (warehouse_id, product_id)
      DO UPDATE SET 
        quantity = COALESCE(warehouse_stock.quantity, 0) + NEW.quantity,
        updated_at = now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 5. Create trigger to auto-assign default warehouse on movements without one
CREATE OR REPLACE FUNCTION public.set_default_warehouse_on_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.warehouse_id IS NULL AND NEW.organization_id IS NOT NULL THEN
    NEW.warehouse_id := public.ensure_default_warehouse(NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$;

-- This trigger must fire BEFORE the insert so warehouse_id is set before update_product_stock runs
DROP TRIGGER IF EXISTS trg_set_default_warehouse_on_movement ON public.stock_movements;
CREATE TRIGGER trg_set_default_warehouse_on_movement
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.set_default_warehouse_on_movement();
