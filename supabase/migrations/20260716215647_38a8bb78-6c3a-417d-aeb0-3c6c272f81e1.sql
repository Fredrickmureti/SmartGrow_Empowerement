
-- ============================================================
-- Phase B — Serialised inventory (ADR 0067)
-- ============================================================

-- 1. Product flag ------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_serial_tracked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.is_serial_tracked IS
  'ADR-0067: when true, every stock_movement for this product must carry serial_number and the product has one row per physical unit in stock_serials.';

-- 2. stock_serials table ----------------------------------------
DO $$ BEGIN
  CREATE TYPE public.stock_serial_status AS ENUM
    ('in_stock','reserved','shipped','returned','scrapped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.stock_serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  serial_number text NOT NULL,
  lot_number text,
  status public.stock_serial_status NOT NULL DEFAULT 'in_stock',
  current_location_id uuid REFERENCES public.stock_locations(id),
  current_warehouse_id uuid,
  last_movement_id uuid,
  received_at timestamptz,
  shipped_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, product_id, serial_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_serials TO authenticated;
GRANT ALL ON public.stock_serials TO service_role;

ALTER TABLE public.stock_serials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_serials_select ON public.stock_serials;
CREATE POLICY stock_serials_select ON public.stock_serials
  FOR SELECT TO authenticated
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
  );

DROP POLICY IF EXISTS stock_serials_write ON public.stock_serials;
CREATE POLICY stock_serials_write ON public.stock_serials
  FOR ALL TO authenticated
  USING (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
    AND user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  )
  WITH CHECK (
    user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR can_access_branch(auth.uid(), branch_id))
    AND user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  );

CREATE INDEX IF NOT EXISTS idx_stock_serials_product
  ON public.stock_serials (business_id, product_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_serials_serial
  ON public.stock_serials (business_id, serial_number);
CREATE INDEX IF NOT EXISTS idx_stock_serials_location
  ON public.stock_serials (current_location_id) WHERE current_location_id IS NOT NULL;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_stock_serials_updated_at ON public.stock_serials;
CREATE TRIGGER trg_stock_serials_updated_at
  BEFORE UPDATE ON public.stock_serials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Movement integrity trigger ---------------------------------
CREATE OR REPLACE FUNCTION public.enforce_serial_on_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_serial boolean;
  v_new_status public.stock_serial_status;
  v_new_location uuid;
BEGIN
  SELECT COALESCE(is_serial_tracked, false)
    INTO v_is_serial
    FROM public.products
   WHERE id = NEW.product_id;

  IF NOT COALESCE(v_is_serial, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.serial_number IS NULL OR btrim(NEW.serial_number) = '' THEN
    RAISE EXCEPTION 'ADR-0067: serial_number is required for stock_movements on serial-tracked product %',
      NEW.product_id
      USING ERRCODE = 'check_violation',
            HINT = 'Set stock_movements.serial_number on every movement for serial-tracked products.';
  END IF;

  -- Derive new status/location from movement type
  v_new_status := CASE NEW.movement_type
    WHEN 'purchase_in'   THEN 'in_stock'::public.stock_serial_status
    WHEN 'transfer_in'   THEN 'in_stock'::public.stock_serial_status
    WHEN 'return_in'     THEN 'returned'::public.stock_serial_status
    WHEN 'adjustment_in' THEN 'in_stock'::public.stock_serial_status
    WHEN 'sale_out'      THEN 'shipped'::public.stock_serial_status
    WHEN 'delivery_out'  THEN 'shipped'::public.stock_serial_status
    WHEN 'transfer_out'  THEN 'reserved'::public.stock_serial_status
    WHEN 'return_out'    THEN 'shipped'::public.stock_serial_status
    WHEN 'adjustment_out' THEN 'scrapped'::public.stock_serial_status
    WHEN 'scrap'         THEN 'scrapped'::public.stock_serial_status
    ELSE NULL
  END;

  v_new_location := COALESCE(NEW.destination_location_id, NEW.source_location_id);

  -- Upsert the serial row (idempotent on business_id + product_id + serial_number)
  INSERT INTO public.stock_serials (
    organization_id, business_id, branch_id,
    product_id, serial_number, lot_number,
    status, current_location_id, current_warehouse_id,
    last_movement_id,
    received_at, shipped_at
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.branch_id,
    NEW.product_id, NEW.serial_number, NEW.lot_number,
    COALESCE(v_new_status, 'in_stock'),
    v_new_location, NEW.warehouse_id,
    NEW.id,
    CASE WHEN v_new_status = 'in_stock' THEN NEW.movement_date END,
    CASE WHEN v_new_status = 'shipped' THEN NEW.movement_date END
  )
  ON CONFLICT (business_id, product_id, serial_number) DO UPDATE
  SET status              = COALESCE(EXCLUDED.status, public.stock_serials.status),
      current_location_id = COALESCE(EXCLUDED.current_location_id, public.stock_serials.current_location_id),
      current_warehouse_id= COALESCE(EXCLUDED.current_warehouse_id, public.stock_serials.current_warehouse_id),
      lot_number          = COALESCE(EXCLUDED.lot_number, public.stock_serials.lot_number),
      last_movement_id    = EXCLUDED.last_movement_id,
      shipped_at          = COALESCE(EXCLUDED.shipped_at, public.stock_serials.shipped_at),
      received_at         = COALESCE(public.stock_serials.received_at, EXCLUDED.received_at),
      updated_at          = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_serial_on_movement ON public.stock_movements;
CREATE TRIGGER trg_enforce_serial_on_movement
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_serial_on_movement();

-- 4. Extend downstream posting guard to serials ------------------
CREATE OR REPLACE FUNCTION public.enforce_downstream_lot_stamping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_line_table text;
  v_fk text;
  v_missing_lot integer;
  v_missing_serial integer;
  v_active boolean;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    v_line_table := 'invoice_items';
    v_fk := 'invoice_id';
    v_active := NEW.status IN ('confirmed','sent','partial','paid','overdue');
  ELSIF TG_TABLE_NAME = 'credit_notes' THEN
    v_line_table := 'credit_note_items';
    v_fk := 'credit_note_id';
    v_active := NEW.status IN ('issued','applied');
  ELSIF TG_TABLE_NAME = 'sales_returns' THEN
    v_line_table := 'sales_return_items';
    v_fk := 'sales_return_id';
    v_active := NEW.status IN ('approved','completed');
  ELSE
    RETURN NEW;
  END IF;

  IF NOT v_active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NEW; END IF;

  EXECUTE format($f$
    SELECT COUNT(*)
      FROM public.%I li
      JOIN public.products p ON p.id = li.product_id
     WHERE li.%I = $1
       AND COALESCE(p.is_lot_tracked, false) = true
       AND li.lot_number IS NULL
  $f$, v_line_table, v_fk)
  INTO v_missing_lot
  USING NEW.id;

  IF v_missing_lot > 0 THEN
    RAISE EXCEPTION 'ADR-0066: % line(s) reference lot-tracked products without lot_number. Stamp lot on every lot-tracked line before posting.',
      v_missing_lot
      USING ERRCODE = 'check_violation',
            HINT = 'Set lot_number on each ' || v_line_table || ' row for lot-tracked products, then retry.';
  END IF;

  EXECUTE format($f$
    SELECT COUNT(*)
      FROM public.%I li
      JOIN public.products p ON p.id = li.product_id
     WHERE li.%I = $1
       AND COALESCE(p.is_serial_tracked, false) = true
       AND (li.serial_number IS NULL OR btrim(li.serial_number) = '')
  $f$, v_line_table, v_fk)
  INTO v_missing_serial
  USING NEW.id;

  IF v_missing_serial > 0 THEN
    RAISE EXCEPTION 'ADR-0067: % line(s) reference serial-tracked products without serial_number. Stamp serial on every serial-tracked line before posting.',
      v_missing_serial
      USING ERRCODE = 'check_violation',
            HINT = 'Set serial_number on each ' || v_line_table || ' row for serial-tracked products, then retry.';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_downstream_lot_stamping IS
  'ADR-0066 + ADR-0067: blocks invoice/credit-note/sales-return posting when any lot-tracked or serial-tracked line is missing its lot_number / serial_number.';
