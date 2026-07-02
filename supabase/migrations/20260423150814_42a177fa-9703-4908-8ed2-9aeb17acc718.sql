-- ─────────────────────────────────────────────────────────────────────────
-- PURCHASES MODULE — Odoo-grade refinement (PART B)
-- 
-- 1. Three-way match: link bill_items → purchase_order_items
-- 2. Multi-currency snapshot on bills + bill_payments
-- 3. Trigger to enforce quantity_billed ≤ quantity_received per PO line
-- 4. Trigger to keep purchase_order_items.quantity_billed in sync with bill_items
-- 5. Trigger to recompute purchase_orders.billing_status
-- ─────────────────────────────────────────────────────────────────────────

-- Step 1: Three-way match link from bill_items to PO line
ALTER TABLE public.bill_items
  ADD COLUMN IF NOT EXISTS purchase_order_item_id uuid REFERENCES public.purchase_order_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bill_items_purchase_order_item_id
  ON public.bill_items(purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;

-- Step 2: Multi-currency snapshot (rate at posting date) on bills
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS currency_rate numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS company_currency_total numeric;

ALTER TABLE public.bill_payments
  ADD COLUMN IF NOT EXISTS currency_rate numeric NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.bills.currency_rate IS
  'Exchange rate from bill currency → company base currency at bill date. Snapshot at posting time so AP can be revalued and FX gain/loss computed at payment.';
COMMENT ON COLUMN public.bills.company_currency_total IS
  'bill.total × bill.currency_rate — total in company base currency. Computed at posting time.';
COMMENT ON COLUMN public.bill_payments.currency_rate IS
  'Exchange rate at payment date. FX gain/loss = (bill.currency_rate - payment.currency_rate) × applied_amount.';

-- Step 3: Three-way match enforcement + PO line quantity_billed sync
-- This trigger:
--   a) Validates Σ(quantity on bill_items linked to a PO line) ≤ quantity_received
--   b) Recomputes purchase_order_items.quantity_billed
--   c) Recomputes purchase_orders.billing_status (no | to_bill | fully_billed)

CREATE OR REPLACE FUNCTION public.sync_po_line_billed_quantities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_line_id uuid;
  v_po_id uuid;
  v_qty_received numeric;
  v_qty_billed numeric;
  v_total_lines integer;
  v_fully_billed_lines integer;
  v_partially_billed_lines integer;
  v_new_status text;
BEGIN
  -- Resolve which PO line(s) to recompute
  IF TG_OP = 'DELETE' THEN
    v_po_line_id := OLD.purchase_order_item_id;
  ELSE
    v_po_line_id := NEW.purchase_order_item_id;
  END IF;

  IF v_po_line_id IS NULL THEN
    -- Bill not linked to a PO — nothing to sync
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Compute total billed quantity for this PO line across non-void bills
  SELECT COALESCE(SUM(bi.quantity), 0), poi.purchase_order_id, COALESCE(poi.quantity_received, 0)
    INTO v_qty_billed, v_po_id, v_qty_received
  FROM public.purchase_order_items poi
  LEFT JOIN public.bill_items bi ON bi.purchase_order_item_id = poi.id
  LEFT JOIN public.bills b ON b.id = bi.bill_id
  WHERE poi.id = v_po_line_id
    AND (b.id IS NULL OR b.status <> 'void')
  GROUP BY poi.id, poi.purchase_order_id, poi.quantity_received;

  -- Three-way match: block over-billing
  IF TG_OP <> 'DELETE' AND v_qty_billed > v_qty_received THEN
    RAISE EXCEPTION
      'Three-way match violation: cannot bill % units on PO line % — only % unit(s) received. Receive the goods first.',
      v_qty_billed, v_po_line_id, v_qty_received
      USING ERRCODE = 'check_violation';
  END IF;

  -- Sync the PO line
  UPDATE public.purchase_order_items
     SET quantity_billed = v_qty_billed
   WHERE id = v_po_line_id;

  -- Recompute PO billing_status
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(quantity_billed,0) >= quantity),
    COUNT(*) FILTER (WHERE COALESCE(quantity_billed,0) > 0 AND COALESCE(quantity_billed,0) < quantity)
  INTO v_total_lines, v_fully_billed_lines, v_partially_billed_lines
  FROM public.purchase_order_items
  WHERE purchase_order_id = v_po_id;

  v_new_status := CASE
    WHEN v_total_lines = 0 THEN 'no'
    WHEN v_fully_billed_lines = v_total_lines THEN 'fully_billed'
    WHEN v_fully_billed_lines > 0 OR v_partially_billed_lines > 0 THEN 'to_bill'
    ELSE 'no'
  END;

  UPDATE public.purchase_orders
     SET billing_status = v_new_status
   WHERE id = v_po_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_bill_items_sync_po_billed ON public.bill_items;
CREATE TRIGGER trg_bill_items_sync_po_billed
  AFTER INSERT OR UPDATE OF quantity, purchase_order_item_id OR DELETE
  ON public.bill_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_po_line_billed_quantities();

-- Also re-sync when a bill is voided (status flips to 'void')
CREATE OR REPLACE FUNCTION public.resync_po_lines_on_bill_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'void' OR OLD.status = 'void')
  THEN
    -- Touch each linked bill_item so the sync trigger runs
    FOR r IN
      SELECT id FROM public.bill_items
       WHERE bill_id = NEW.id AND purchase_order_item_id IS NOT NULL
    LOOP
      UPDATE public.bill_items SET quantity = quantity WHERE id = r.id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_resync_po_on_void ON public.bills;
CREATE TRIGGER trg_bills_resync_po_on_void
  AFTER UPDATE OF status ON public.bills
  FOR EACH ROW
  EXECUTE FUNCTION public.resync_po_lines_on_bill_void();
