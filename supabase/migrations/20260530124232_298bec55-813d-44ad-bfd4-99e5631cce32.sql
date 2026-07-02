-- =====================================================================
-- Phase 2: Lot-level on-hand maintenance + product tracking flags
-- Closes Gap B from the inventory audit.
-- =====================================================================

-- 1. Product-level tracking switches
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_lot_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_expiry_tracked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_alert_days integer NOT NULL DEFAULT 30
    CHECK (expiry_alert_days >= 0);

COMMENT ON COLUMN public.products.is_lot_tracked IS
  'When true, outbound stock movements for this product MUST carry a lot_number. Drives lot quant maintenance and FEFO picking.';
COMMENT ON COLUMN public.products.is_expiry_tracked IS
  'When true, FEFO (first-expiring-first-out) picking is used at sale/POS/transfer/adjustment time. Implies is_lot_tracked semantics.';
COMMENT ON COLUMN public.products.expiry_alert_days IS
  'Days-to-expiry threshold below which a notification is raised for lots of this product.';

-- 2. Maintenance trigger: keep warehouse_stock_lots.quantity in sync with movements
CREATE OR REPLACE FUNCTION public._maintain_warehouse_stock_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_qty_abs   numeric;
  v_is_in     boolean;
  v_is_out    boolean;
  v_lot_id    uuid;
  v_is_lot_tracked boolean;
  v_signed_delta numeric;
BEGIN
  IF NEW.product_id IS NULL OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_qty_abs := abs(COALESCE(NEW.quantity, 0));
  IF v_qty_abs = 0 THEN RETURN NEW; END IF;

  v_is_in  := NEW.movement_type::text IN
    ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return');
  v_is_out := NEW.movement_type::text IN
    ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return');

  IF NOT (v_is_in OR v_is_out) THEN
    RETURN NEW;
  END IF;

  -- Enforce lot discipline for products that require it
  SELECT is_lot_tracked INTO v_is_lot_tracked FROM public.products WHERE id = NEW.product_id;

  IF NEW.lot_number IS NULL OR NEW.lot_number = '' THEN
    IF COALESCE(v_is_lot_tracked, false) AND v_is_out THEN
      RAISE EXCEPTION 'Product % is lot-tracked but outbound movement % has no lot_number',
        NEW.product_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- No lot on this row → nothing more to do; warehouse_stock trigger handles the aggregate.
    RETURN NEW;
  END IF;

  -- Resolve or create the lot master
  SELECT id INTO v_lot_id
    FROM public.stock_lots
   WHERE business_id = NEW.business_id
     AND product_id  = NEW.product_id
     AND lot_number  = NEW.lot_number
     AND (
       (serial_number IS NULL AND NEW.serial_number IS NULL)
       OR serial_number = NEW.serial_number
     )
   LIMIT 1;

  IF v_lot_id IS NULL THEN
    IF v_is_out THEN
      RAISE EXCEPTION 'Lot % does not exist for product % — cannot consume',
        NEW.lot_number, NEW.product_id
        USING ERRCODE = 'no_data_found';
    END IF;
    -- Receipt path: lot master is born here
    INSERT INTO public.stock_lots (
      organization_id, business_id, product_id, lot_number, serial_number
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.product_id, NEW.lot_number, NEW.serial_number
    )
    ON CONFLICT (business_id, product_id, lot_number, serial_number) DO NOTHING
    RETURNING id INTO v_lot_id;

    IF v_lot_id IS NULL THEN
      SELECT id INTO v_lot_id FROM public.stock_lots
       WHERE business_id = NEW.business_id
         AND product_id  = NEW.product_id
         AND lot_number  = NEW.lot_number
         AND (
           (serial_number IS NULL AND NEW.serial_number IS NULL)
           OR serial_number = NEW.serial_number
         );
    END IF;
  END IF;

  v_signed_delta := CASE WHEN v_is_in THEN v_qty_abs ELSE -v_qty_abs END;

  INSERT INTO public.warehouse_stock_lots (
    organization_id, business_id, warehouse_id, product_id, lot_id, quantity
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id, v_lot_id, v_signed_delta
  )
  ON CONFLICT (business_id, warehouse_id, product_id, lot_id)
  DO UPDATE SET quantity = public.warehouse_stock_lots.quantity + v_signed_delta;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maintain_warehouse_stock_lots ON public.stock_movements;
CREATE TRIGGER trg_maintain_warehouse_stock_lots
AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._maintain_warehouse_stock_lots();

-- 3. Indexes that FEFO and reporting will rely on
CREATE INDEX IF NOT EXISTS idx_stock_lots_expiry
  ON public.stock_lots (business_id, product_id, expiry_date NULLS LAST)
  WHERE expiry_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_stock_lots_available
  ON public.warehouse_stock_lots (business_id, warehouse_id, product_id, lot_id)
  WHERE quantity > 0;

-- 4. Backfill / rebuild RPC (idempotent, per business)
CREATE OR REPLACE FUNCTION public.rebuild_warehouse_stock_lots(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_id uuid;
  v_rows_written integer := 0;
BEGIN
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'business_id required');
  END IF;

  -- Permission: org admin only
  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Business not found');
  END IF;

  IF NOT public.is_org_admin(auth.uid(), v_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Org admin role required');
  END IF;

  -- Auto-create missing lot masters from movement history
  INSERT INTO public.stock_lots (organization_id, business_id, product_id, lot_number, serial_number)
  SELECT DISTINCT sm.organization_id, sm.business_id, sm.product_id, sm.lot_number, sm.serial_number
    FROM public.stock_movements sm
   WHERE sm.business_id = p_business_id
     AND sm.lot_number IS NOT NULL AND sm.lot_number <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.stock_lots sl
        WHERE sl.business_id = sm.business_id
          AND sl.product_id  = sm.product_id
          AND sl.lot_number  = sm.lot_number
          AND ((sl.serial_number IS NULL AND sm.serial_number IS NULL)
               OR sl.serial_number = sm.serial_number)
     )
  ON CONFLICT (business_id, product_id, lot_number, serial_number) DO NOTHING;

  -- Truncate-and-rebuild the per-lot quants for this business
  DELETE FROM public.warehouse_stock_lots WHERE business_id = p_business_id;

  WITH movement_deltas AS (
    SELECT
      sm.organization_id, sm.business_id, sm.warehouse_id, sm.product_id,
      sl.id AS lot_id,
      SUM(
        CASE
          WHEN sm.movement_type::text IN
               ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return')
            THEN abs(sm.quantity)
          WHEN sm.movement_type::text IN
               ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return')
            THEN -abs(sm.quantity)
          ELSE 0
        END
      ) AS qty
    FROM public.stock_movements sm
    JOIN public.stock_lots sl
      ON sl.business_id = sm.business_id
     AND sl.product_id  = sm.product_id
     AND sl.lot_number  = sm.lot_number
     AND ((sl.serial_number IS NULL AND sm.serial_number IS NULL)
          OR sl.serial_number = sm.serial_number)
    WHERE sm.business_id = p_business_id
      AND sm.lot_number IS NOT NULL AND sm.lot_number <> ''
      AND sm.warehouse_id IS NOT NULL
    GROUP BY sm.organization_id, sm.business_id, sm.warehouse_id, sm.product_id, sl.id
  )
  INSERT INTO public.warehouse_stock_lots (
    organization_id, business_id, warehouse_id, product_id, lot_id, quantity
  )
  SELECT organization_id, business_id, warehouse_id, product_id, lot_id, GREATEST(qty, 0)
    FROM movement_deltas
   WHERE qty > 0;

  GET DIAGNOSTICS v_rows_written = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'business_id', p_business_id,
    'rows_written', v_rows_written
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebuild_warehouse_stock_lots(uuid) TO authenticated;

-- 5. Drift detection view: per-lot sums vs warehouse aggregate
CREATE OR REPLACE VIEW public.lot_quant_drift_view AS
WITH lot_sums AS (
  SELECT business_id, warehouse_id, product_id, SUM(quantity) AS lot_total
    FROM public.warehouse_stock_lots
   GROUP BY business_id, warehouse_id, product_id
)
SELECT
  ws.business_id,
  ws.warehouse_id,
  w.name        AS warehouse_name,
  ws.product_id,
  p.name        AS product_name,
  p.is_lot_tracked,
  ws.quantity   AS warehouse_total,
  COALESCE(ls.lot_total, 0) AS lot_total,
  ws.quantity - COALESCE(ls.lot_total, 0) AS drift
FROM public.warehouse_stock ws
JOIN public.products   p ON p.id = ws.product_id
JOIN public.warehouses w ON w.id = ws.warehouse_id
LEFT JOIN lot_sums ls
       ON ls.business_id = ws.business_id
      AND ls.warehouse_id = ws.warehouse_id
      AND ls.product_id   = ws.product_id
WHERE p.is_lot_tracked = true
  AND ABS(ws.quantity - COALESCE(ls.lot_total, 0)) > 0.0001;

COMMENT ON VIEW public.lot_quant_drift_view IS
  'Phase 2 (lot quants) drift detector. Lists lot-tracked products whose per-lot warehouse_stock_lots balances no longer sum to the warehouse_stock total. A non-empty result means rebuild_warehouse_stock_lots() should be run.';

GRANT SELECT ON public.lot_quant_drift_view TO authenticated;