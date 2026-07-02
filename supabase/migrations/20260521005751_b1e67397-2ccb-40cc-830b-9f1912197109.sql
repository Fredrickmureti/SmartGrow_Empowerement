-- =====================================================================
-- Inventory adjustment GL integrity overhaul (Phase A)
-- =====================================================================

-- A3. Per-warehouse moving-average cost ---------------------------------
ALTER TABLE public.warehouse_stock
  ADD COLUMN IF NOT EXISTS average_cost numeric;

COMMENT ON COLUMN public.warehouse_stock.average_cost IS
  'Per-warehouse moving average cost. Maintained by update_weighted_avg_cost trigger on inbound stock_movements. Falls back to products.cost_price when null.';

-- A1. Server-authoritative cost resolver --------------------------------
CREATE OR REPLACE FUNCTION public.resolve_adjustment_unit_cost(
  p_org_id uuid,
  p_business_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_provided numeric
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost numeric;
BEGIN
  -- 1. Caller-provided cost wins when positive.
  IF p_provided IS NOT NULL AND p_provided > 0 THEN
    RETURN p_provided;
  END IF;

  -- 2. Per-warehouse moving average.
  SELECT average_cost INTO v_cost
    FROM public.warehouse_stock
   WHERE product_id = p_product_id
     AND warehouse_id = p_warehouse_id
   LIMIT 1;
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 3. Product-level cost (company-wide AVCO).
  SELECT cost_price INTO v_cost
    FROM public.products
   WHERE id = p_product_id;
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 4. Last inbound movement cost.
  SELECT unit_cost INTO v_cost
    FROM public.stock_movements
   WHERE product_id = p_product_id
     AND unit_cost IS NOT NULL
     AND unit_cost > 0
     AND quantity > 0
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_cost IS NOT NULL AND v_cost > 0 THEN
    RETURN v_cost;
  END IF;

  -- 5. Give up — caller must error.
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_unit_cost(uuid, uuid, uuid, uuid, numeric) TO authenticated, service_role;

-- A2 + C1. Hardened approval RPC ----------------------------------------
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(p_adjustment_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_adjustment RECORD;
  v_item RECORD;
  v_org_id UUID;
  v_biz_id UUID;
  v_branch_id UUID;
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_resolved_cost numeric;
  v_cost_value numeric;
  v_lines jsonb := '[]'::jsonb;
  v_locked_qty numeric;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment is already approved');
  END IF;

  IF v_adjustment.status NOT IN ('draft', 'pending_approval') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment cannot be approved (current status: ' || v_adjustment.status || ')');
  END IF;

  v_org_id    := v_adjustment.organization_id;
  v_biz_id    := v_adjustment.business_id;
  v_branch_id := v_adjustment.branch_id;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  -- Pre-flight: provision GL accounts before any mutation so we fail fast
  -- and predictably if chart of accounts is incomplete.
  SELECT inventory_account_id, adjustment_account_id
    INTO v_inventory_account_id, v_adjustment_account_id
    FROM public.ensure_inventory_gl_accounts(v_org_id, v_biz_id);

  IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot approve stock adjustment: inventory or adjustment GL account not provisioned for company %', v_biz_id;
  END IF;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    -- C1. Lock the per-warehouse stock row so two concurrent adjustments
    -- cannot read the same baseline.
    SELECT quantity INTO v_locked_qty
      FROM public.warehouse_stock
     WHERE product_id = v_item.product_id
       AND warehouse_id = v_item.warehouse_id
     FOR UPDATE;
    -- (row may not exist yet — that's fine; the stock_movement insert/trigger
    -- will create it. The lock simply serializes subsequent writers when it does.)

    -- A2. Resolve the cost server-side. Zero-qty lines need no cost.
    IF v_item.quantity_adjustment = 0 THEN
      v_resolved_cost := 0;
    ELSE
      v_resolved_cost := public.resolve_adjustment_unit_cost(
        v_org_id, v_biz_id, v_item.product_id, v_item.warehouse_id, v_item.unit_cost
      );
      IF v_resolved_cost IS NULL OR v_resolved_cost <= 0 THEN
        RAISE EXCEPTION 'Cannot approve stock adjustment: no valuation cost is available for product %. Provide a unit cost on the adjustment line, or set the product cost first.', v_item.product_id;
      END IF;

      -- Persist resolved cost back onto the adjustment line for audit.
      IF v_item.unit_cost IS DISTINCT FROM v_resolved_cost THEN
        UPDATE public.stock_adjustment_items
           SET unit_cost = v_resolved_cost
         WHERE id = v_item.id;
      END IF;
    END IF;

    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_resolved_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost_value := ABS(v_item.quantity_adjustment) * COALESCE(v_resolved_cost, 0);
    IF v_cost_value > 0 THEN
      IF v_item.quantity_adjustment > 0 THEN
        v_total_positive := v_total_positive + v_cost_value;
      ELSE
        v_total_negative := v_total_negative + v_cost_value;
      END IF;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  UPDATE approval_rule_logs
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE entity_type = 'stock_adjustment'
     AND entity_id = p_adjustment_id::text
     AND action_name = 'apply'
     AND status = 'pending';

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    IF v_total_positive > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_inventory_account_id,
          'debit',  v_total_positive,
          'credit', 0,
          'description', 'Stock Adjustment - Inventory Increase'
        ),
        jsonb_build_object(
          'account_id', v_adjustment_account_id,
          'debit',  0,
          'credit', v_total_positive,
          'description', 'Stock Adjustment - Inventory Increase Offset'
        )
      );
    END IF;

    IF v_total_negative > 0 THEN
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object(
          'account_id', v_adjustment_account_id,
          'debit',  v_total_negative,
          'credit', 0,
          'description', 'Stock Adjustment - Shrinkage/Loss'
        ),
        jsonb_build_object(
          'account_id', v_inventory_account_id,
          'debit',  0,
          'credit', v_total_negative,
          'description', 'Stock Adjustment - Inventory Reduction'
        )
      );
    END IF;

    v_journal_id := public.post_journal_entry_atomic(
      _org_id          := v_org_id,
      _business_id     := v_biz_id,
      _entry_number    := public.get_next_journal_entry_number(v_org_id),
      _entry_date      := CURRENT_DATE,
      _reference       := 'ADJ-' || LEFT(p_adjustment_id::text, 8),
      _description     := 'Stock adjustment approved',
      _source_type     := 'stock_adjustment',
      _source_id       := p_adjustment_id,
      _created_by      := p_user_id,
      _is_closing      := false,
      _is_adjusting    := false,
      _lines           := v_lines,
      _branch_id       := v_branch_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'status', 'approved',
    'gl_posted', v_journal_id IS NOT NULL,
    'journal_entry_id', v_journal_id,
    'total_value', v_total_positive + v_total_negative
  );
END;
$function$;

-- A4. Extend AVCO trigger to also account for "found stock" adjustments
CREATE OR REPLACE FUNCTION public.update_weighted_avg_cost_on_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_qty numeric;
  v_old_cost numeric;
  v_new_cost numeric;
  v_new_total_qty numeric;
  v_ws_old_qty numeric;
  v_ws_old_cost numeric;
  v_ws_new_cost numeric;
BEGIN
  -- Only fire on inbound (positive qty) for receipt/purchase/adjustment with a real cost.
  IF NEW.movement_type NOT IN ('receipt', 'purchase', 'adjustment') OR NEW.quantity <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.unit_cost IS NULL OR NEW.unit_cost <= 0 THEN
    RETURN NEW;
  END IF;

  -- Company-wide product AVCO (legacy).
  SELECT
    COALESCE(p.stock_quantity, 0) - NEW.quantity,
    COALESCE(p.cost_price, 0)
  INTO v_old_qty, v_old_cost
  FROM products p WHERE p.id = NEW.product_id;

  IF v_old_qty <= 0 THEN
    v_new_cost := NEW.unit_cost;
  ELSE
    v_new_total_qty := v_old_qty + NEW.quantity;
    v_new_cost := ((v_old_qty * v_old_cost) + (NEW.quantity * NEW.unit_cost)) / v_new_total_qty;
  END IF;

  UPDATE products
     SET cost_price = ROUND(v_new_cost, 4)
   WHERE id = NEW.product_id;

  -- Per-warehouse AVCO.
  IF NEW.warehouse_id IS NOT NULL THEN
    SELECT
      COALESCE(ws.quantity, 0) - NEW.quantity,
      COALESCE(ws.average_cost, 0)
    INTO v_ws_old_qty, v_ws_old_cost
    FROM warehouse_stock ws
    WHERE ws.product_id = NEW.product_id
      AND ws.warehouse_id = NEW.warehouse_id;

    IF v_ws_old_qty IS NULL OR v_ws_old_qty <= 0 OR v_ws_old_cost <= 0 THEN
      v_ws_new_cost := NEW.unit_cost;
    ELSE
      v_ws_new_cost := ((v_ws_old_qty * v_ws_old_cost) + (NEW.quantity * NEW.unit_cost))
                      / (v_ws_old_qty + NEW.quantity);
    END IF;

    UPDATE warehouse_stock
       SET average_cost = ROUND(v_ws_new_cost, 4)
     WHERE product_id = NEW.product_id
       AND warehouse_id = NEW.warehouse_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_wac_on_receipt ON public.stock_movements;
CREATE TRIGGER trg_update_wac_on_receipt
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW
  WHEN (
    NEW.movement_type IN ('receipt', 'purchase', 'adjustment')
    AND NEW.quantity > 0
    AND NEW.unit_cost IS NOT NULL
    AND NEW.unit_cost > 0
  )
  EXECUTE FUNCTION public.update_weighted_avg_cost_on_receipt();

COMMENT ON FUNCTION public.approve_stock_adjustment_atomic(uuid, uuid) IS
  'Approves a stock adjustment atomically: resolves valuation cost server-side, locks per-warehouse stock rows, inserts stock_movements with resolved cost, and posts a balanced journal entry via post_journal_entry_atomic. Raises when no valuation cost can be resolved for a non-zero line. See docs/audit/2026-05-21-inventory-adjustment-gl.md.';