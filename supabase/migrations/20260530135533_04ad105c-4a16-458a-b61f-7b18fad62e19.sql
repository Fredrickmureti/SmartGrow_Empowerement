-- =====================================================================
-- Phase 1 — Lot trigger hardening
--
-- Closes Gap B2 from docs/audit/2026-06-08-uom-packaging-reaudit.md
-- (follow-on plan). _maintain_warehouse_stock_lots previously only
-- classified the explicit *_in / *_out movement tokens. Atomic RPCs
-- that emit the legacy generic tokens ('adjustment', 'transfer') with
-- a signed quantity were silently skipped, causing per-lot quants to
-- drift away from warehouse_stock on lot-tracked products.
--
-- Fix: classify 'adjustment' and 'transfer' by sign(NEW.quantity).
-- Behaviour for products with is_lot_tracked = false is unchanged
-- (trigger still returns early when no lot_number is present).
-- =====================================================================

CREATE OR REPLACE FUNCTION public._maintain_warehouse_stock_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_qty_abs   numeric;
  v_is_in     boolean;
  v_is_out    boolean;
  v_lot_id    uuid;
  v_is_lot_tracked boolean;
  v_signed_delta numeric;
  v_mt text;
BEGIN
  IF NEW.product_id IS NULL OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_qty_abs := abs(COALESCE(NEW.quantity, 0));
  IF v_qty_abs = 0 THEN RETURN NEW; END IF;

  v_mt := NEW.movement_type::text;

  v_is_in  := v_mt IN
    ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return');
  v_is_out := v_mt IN
    ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return');

  -- Legacy generic tokens emitted by older atomic RPCs (approve_stock_adjustment_atomic,
  -- approve_stock_transfer_atomic) carry the direction in sign(NEW.quantity).
  IF NOT (v_is_in OR v_is_out) AND v_mt IN ('adjustment','transfer') THEN
    IF NEW.quantity > 0 THEN
      v_is_in := true;
    ELSIF NEW.quantity < 0 THEN
      v_is_out := true;
    END IF;
  END IF;

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

COMMENT ON FUNCTION public._maintain_warehouse_stock_lots() IS
  'AFTER INSERT trigger on stock_movements. Maintains per-lot quants in warehouse_stock_lots. Classifies movement_type by explicit *_in/*_out tokens; for legacy generic tokens (adjustment, transfer) it falls back to sign(quantity).';

-- Also update the matching SUM CASE inside rebuild_warehouse_stock_lots so a
-- replay produces the same result as the live trigger.
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

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Business not found');
  END IF;

  IF NOT public.is_org_admin(auth.uid(), v_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Org admin role required');
  END IF;

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
          -- Legacy generic tokens carry direction in sign(quantity)
          WHEN sm.movement_type::text IN ('adjustment','transfer')
            THEN sm.quantity
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