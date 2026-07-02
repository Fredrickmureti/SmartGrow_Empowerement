
-- ============================================================
-- PHASE A — warehouse_stock scope lock-down
-- ============================================================

-- Tables are empty in this environment, but if any rows exist
-- (other envs), backfill from warehouses before NOT NULL.
UPDATE public.warehouse_stock ws
   SET business_id = w.business_id,
       branch_id   = w.branch_id
  FROM public.warehouses w
 WHERE ws.warehouse_id = w.id
   AND (ws.business_id IS NULL OR ws.branch_id IS NULL);

-- Drop any rows that still can't be scoped (defensive; should be 0).
DELETE FROM public.warehouse_stock
 WHERE business_id IS NULL OR branch_id IS NULL;

ALTER TABLE public.warehouse_stock
  ALTER COLUMN business_id SET NOT NULL,
  ALTER COLUMN branch_id   SET NOT NULL;

-- Same for stock_movements.branch_id (business_id is already NOT NULL).
UPDATE public.stock_movements sm
   SET branch_id = w.branch_id
  FROM public.warehouses w
 WHERE sm.warehouse_id = w.id
   AND sm.branch_id IS NULL
   AND w.branch_id IS NOT NULL;

-- ============================================================
-- PHASE A.3 — update_product_stock now stamps business_id + branch_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_product_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) + NEW.quantity
     WHERE id = NEW.product_id;

    IF NEW.warehouse_id IS NOT NULL THEN
      SELECT business_id, branch_id INTO v_wh
        FROM public.warehouses WHERE id = NEW.warehouse_id;

      INSERT INTO public.warehouse_stock (
        organization_id, business_id, branch_id,
        warehouse_id, product_id, quantity, reserved_quantity
      )
      VALUES (
        NEW.organization_id, v_wh.business_id, v_wh.branch_id,
        NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
      )
      ON CONFLICT (warehouse_id, product_id) DO UPDATE
         SET quantity   = COALESCE(public.warehouse_stock.quantity, 0) + NEW.quantity,
             updated_at = now();
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity
     WHERE id = OLD.product_id;

    IF OLD.warehouse_id IS NOT NULL THEN
      UPDATE public.warehouse_stock
         SET quantity   = COALESCE(quantity, 0) - OLD.quantity,
             updated_at = now()
       WHERE warehouse_id = OLD.warehouse_id
         AND product_id   = OLD.product_id;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity + NEW.quantity
     WHERE id = NEW.product_id;

    IF OLD.warehouse_id IS NOT NULL THEN
      UPDATE public.warehouse_stock
         SET quantity   = COALESCE(quantity, 0) - OLD.quantity,
             updated_at = now()
       WHERE warehouse_id = OLD.warehouse_id
         AND product_id   = OLD.product_id;
    END IF;

    IF NEW.warehouse_id IS NOT NULL THEN
      SELECT business_id, branch_id INTO v_wh
        FROM public.warehouses WHERE id = NEW.warehouse_id;

      INSERT INTO public.warehouse_stock (
        organization_id, business_id, branch_id,
        warehouse_id, product_id, quantity, reserved_quantity
      )
      VALUES (
        NEW.organization_id, v_wh.business_id, v_wh.branch_id,
        NEW.warehouse_id, NEW.product_id, NEW.quantity, 0
      )
      ON CONFLICT (warehouse_id, product_id) DO UPDATE
         SET quantity   = COALESCE(public.warehouse_stock.quantity, 0) + NEW.quantity,
             updated_at = now();
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================
-- PHASE A.4 — create_invoice_stock_movements requires warehouse + stamps business
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_invoice_stock_movements(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_created_by uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item RECORD;
  v_inv RECORD;
  v_wh RECORD;
  v_business_id uuid;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'create_invoice_stock_movements: warehouse_id is required (no default-warehouse fallback)';
  END IF;

  SELECT invoice_number, business_id
    INTO v_inv
    FROM invoices WHERE id = p_invoice_id;

  IF v_inv.business_id IS NULL THEN
    RAISE EXCEPTION 'create_invoice_stock_movements: invoice % has no business_id', p_invoice_id;
  END IF;

  SELECT business_id, branch_id, organization_id INTO v_wh
    FROM warehouses WHERE id = p_warehouse_id;

  IF v_wh.business_id IS DISTINCT FROM v_inv.business_id THEN
    RAISE EXCEPTION 'Warehouse % belongs to a different company than invoice %', p_warehouse_id, p_invoice_id;
  END IF;

  v_business_id := v_inv.business_id;

  FOR v_item IN
    SELECT ii.product_id, ii.quantity
      FROM invoice_items ii
      JOIN products p ON p.id = ii.product_id
     WHERE ii.invoice_id   = p_invoice_id
       AND ii.product_id   IS NOT NULL
       AND p.track_inventory = true
  LOOP
    INSERT INTO stock_movements (
      organization_id, business_id, branch_id,
      product_id, warehouse_id, movement_type, quantity,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      p_organization_id, v_business_id, v_wh.branch_id,
      v_item.product_id, p_warehouse_id, 'sale', -v_item.quantity,
      'invoice', p_invoice_id,
      'Invoice ' || COALESCE(v_inv.invoice_number, ''),
      p_created_by
    );
  END LOOP;
END;
$function$;

-- ============================================================
-- PHASE A.6 — Drop the silent default-warehouse trigger and helper
-- ============================================================
DROP TRIGGER IF EXISTS trg_set_default_warehouse_on_movement ON public.stock_movements;
DROP FUNCTION IF EXISTS public.set_default_warehouse_on_movement() CASCADE;
DROP FUNCTION IF EXISTS public.ensure_default_warehouse(uuid) CASCADE;

-- Hard-require warehouse_id on stock_movements so the next caller can't omit it.
ALTER TABLE public.stock_movements
  ALTER COLUMN warehouse_id SET NOT NULL;

-- ============================================================
-- PHASE B.7 — Stale movement_type CHECK
-- ============================================================
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY[
    'purchase','sale','pos_sale','pos_return',
    'receipt','delivery','adjustment',
    'return_in','return_out','transfer',
    'opening','scrap','count','migration'
  ]));

-- ============================================================
-- PHASE B.8 — Drop the older WAC trigger; keep _on_receipt
-- ============================================================
DROP TRIGGER IF EXISTS trg_update_weighted_average_cost ON public.stock_movements;
DROP FUNCTION IF EXISTS public.update_weighted_average_cost() CASCADE;

-- ============================================================
-- PHASE C.9 — approve_stock_adjustment_atomic: scope GL accounts by business_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment_atomic(
  p_adjustment_id uuid,
  p_user_id uuid
)
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
  v_inventory_account_id UUID;
  v_adjustment_account_id UUID;
  v_total_positive numeric := 0;
  v_total_negative numeric := 0;
  v_journal_id UUID;
  v_cost numeric;
BEGIN
  SELECT id, organization_id, business_id, status
    INTO v_adjustment
    FROM stock_adjustments
   WHERE id = p_adjustment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjustment not found');
  END IF;

  IF v_adjustment.status != 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment is not in draft status (current: ' || v_adjustment.status || ')');
  END IF;

  v_org_id := v_adjustment.organization_id;
  v_biz_id := v_adjustment.business_id;

  IF v_biz_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Adjustment has no business_id; cannot post to GL');
  END IF;

  FOR v_item IN
    SELECT * FROM stock_adjustment_items WHERE adjustment_id = p_adjustment_id
  LOOP
    INSERT INTO stock_movements (
      organization_id, business_id, product_id, movement_type,
      quantity, unit_cost, warehouse_id,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_org_id, v_biz_id, v_item.product_id, 'adjustment',
      v_item.quantity_adjustment, v_item.unit_cost, v_item.warehouse_id,
      'stock_adjustment', p_adjustment_id, v_item.notes, p_user_id
    );

    v_cost := ABS(v_item.quantity_adjustment) * COALESCE(v_item.unit_cost, 0);
    IF v_cost > 0 THEN
      IF v_item.quantity_adjustment > 0 THEN
        v_total_positive := v_total_positive + v_cost;
      ELSE
        v_total_negative := v_total_negative + v_cost;
      END IF;
    END IF;
  END LOOP;

  UPDATE stock_adjustments
     SET status = 'approved',
         approved_by = p_user_id,
         approved_at = now()
   WHERE id = p_adjustment_id;

  -- Scope account lookups to the company, not just the workspace.
  SELECT a.id INTO v_inventory_account_id
    FROM accounts a
   WHERE a.organization_id = v_org_id
     AND a.business_id     = v_biz_id
     AND a.detail_type     = 'inventory'
     AND a.is_active       = true
   LIMIT 1;

  SELECT a.id INTO v_adjustment_account_id
    FROM accounts a
   WHERE a.organization_id = v_org_id
     AND a.business_id     = v_biz_id
     AND a.detail_type     = 'inventory_adjustment'
     AND a.is_active       = true
   LIMIT 1;

  IF v_adjustment_account_id IS NULL THEN
    SELECT a.id INTO v_adjustment_account_id
      FROM accounts a
     WHERE a.organization_id = v_org_id
       AND a.business_id     = v_biz_id
       AND a.detail_type     = 'operating_expenses'
       AND a.is_active       = true
     LIMIT 1;
  END IF;

  IF (v_total_positive > 0 OR v_total_negative > 0) THEN
    IF v_inventory_account_id IS NULL OR v_adjustment_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post stock adjustment to GL: missing inventory or adjustment account for company %', v_biz_id;
    END IF;

    INSERT INTO journal_entries (
      organization_id, business_id, entry_date, reference, memo,
      source_type, source_id, status, created_by
    ) VALUES (
      v_org_id, v_biz_id, CURRENT_DATE,
      'ADJ-' || LEFT(p_adjustment_id::text, 8),
      'Stock adjustment approved',
      'stock_adjustment', 'stock-adj-' || p_adjustment_id::text,
      'posted', p_user_id
    ) RETURNING id INTO v_journal_id;

    IF v_total_positive > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_inventory_account_id,  v_total_positive, 0, 'Stock Adjustment - Inventory Increase'),
        (v_journal_id, v_adjustment_account_id, 0, v_total_positive, 'Stock Adjustment - Inventory Increase Offset');
    END IF;

    IF v_total_negative > 0 THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES
        (v_journal_id, v_adjustment_account_id, v_total_negative, 0, 'Stock Adjustment - Shrinkage/Loss'),
        (v_journal_id, v_inventory_account_id, 0, v_total_negative, 'Stock Adjustment - Inventory Reduction');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'adjustment_id', p_adjustment_id,
                            'gl_posted', v_journal_id IS NOT NULL);
END;
$function$;

-- ============================================================
-- PHASE D.10 — reserve_stock / release_stock: branch-aware, drop legacy 3-arg
-- ============================================================
DROP FUNCTION IF EXISTS public.reserve_stock(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.reserve_stock(
  p_organization_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_reference_type text DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh RECORD;
  v_on_hand NUMERIC;
  v_reserved NUMERIC;
  v_available NUMERIC;
BEGIN
  SELECT business_id, branch_id, organization_id INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse not found');
  END IF;

  IF v_wh.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Warehouse belongs to a different workspace');
  END IF;

  SELECT quantity, reserved_quantity
    INTO v_on_hand, v_reserved
    FROM warehouse_stock
   WHERE organization_id = p_organization_id
     AND business_id     = v_wh.business_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found', 'available', 0);
  END IF;

  v_available := COALESCE(v_on_hand, 0) - COALESCE(v_reserved, 0);

  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient available stock', 'available', v_available);
  END IF;

  UPDATE warehouse_stock
     SET reserved_quantity = COALESCE(reserved_quantity, 0) + p_quantity,
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id;

  RETURN jsonb_build_object('success', true, 'reserved', p_quantity, 'available', v_available - p_quantity);
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_stock(
  p_organization_id uuid,
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh RECORD;
  v_current_reserved NUMERIC;
  v_release_qty NUMERIC;
BEGIN
  SELECT business_id, organization_id INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse not found');
  END IF;

  IF v_wh.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Warehouse belongs to a different workspace');
  END IF;

  SELECT reserved_quantity
    INTO v_current_reserved
    FROM warehouse_stock
   WHERE organization_id = p_organization_id
     AND business_id     = v_wh.business_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found');
  END IF;

  v_release_qty := LEAST(p_quantity, COALESCE(v_current_reserved, 0));

  UPDATE warehouse_stock
     SET reserved_quantity = COALESCE(reserved_quantity, 0) - v_release_qty,
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id;

  RETURN jsonb_build_object('success', true, 'released', v_release_qty);
END;
$function$;

-- ============================================================
-- PHASE E.11 — Warehouse code uniqueness: per-company, not per-workspace
-- ============================================================
ALTER TABLE public.warehouses
  DROP CONSTRAINT IF EXISTS warehouses_organization_id_code_key;

ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_business_id_code_key UNIQUE (business_id, code);

-- ============================================================
-- PHASE E.13 — product_reorder_rules: optional branch_id override
-- ============================================================
ALTER TABLE public.product_reorder_rules
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE;

-- Replace old uniqueness with one that includes branch_id (NULLS NOT DISTINCT
-- so a single company-wide row coexists with per-branch overrides).
ALTER TABLE public.product_reorder_rules
  DROP CONSTRAINT IF EXISTS product_reorder_rules_organization_id_product_id_warehouse__key;

CREATE UNIQUE INDEX IF NOT EXISTS product_reorder_rules_unique_scope
  ON public.product_reorder_rules (organization_id, business_id, product_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS product_reorder_rules_branch_idx
  ON public.product_reorder_rules (branch_id) WHERE branch_id IS NOT NULL;
