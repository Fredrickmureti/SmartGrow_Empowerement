-- Add is_sample_data flag to inventory tables
ALTER TABLE public.product_categories     ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.warehouses             ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.warehouse_stock        ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.stock_adjustments      ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.stock_adjustment_items ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.stock_movements        ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_product_categories_sample ON public.product_categories(organization_id) WHERE is_sample_data;
CREATE INDEX IF NOT EXISTS idx_warehouses_sample         ON public.warehouses(organization_id)         WHERE is_sample_data;
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_sample    ON public.warehouse_stock(organization_id)    WHERE is_sample_data;
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_sample  ON public.stock_adjustments(organization_id)  WHERE is_sample_data;

-- Extend clear_sample_data to cover inventory entities
CREATE OR REPLACE FUNCTION public.clear_sample_data(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
    OR public.has_role(v_user, org_id, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: admin/owner required' USING ERRCODE='42501';
  END IF;

  -- ===== Existing transactional cleanup (unchanged) =====
  WITH d AS (DELETE FROM bank_reconciliation_items WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_sessions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payment_allocations WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_payments WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payments WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_applications WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_items WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_notes WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_note_applications WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_note_items WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_notes WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_return_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_returns WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_returns', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_note_items WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_notes WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bills WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bills', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_orders WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_orders WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimate_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimate_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimates WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimates', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM recurring_invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('recurring_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM expenses WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('expenses', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entry_lines', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entries', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_transactions WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_transactions', v_n); v_total := v_total + v_n;

  -- ===== NEW: Inventory cleanup (must run before products) =====
  WITH d AS (DELETE FROM stock_movements WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_movements', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM stock_adjustment_items WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_adjustment_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM stock_adjustments WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_adjustments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM warehouse_stock WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('warehouse_stock', v_n); v_total := v_total + v_n;

  -- ===== Products & contacts =====
  WITH d AS (DELETE FROM products WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('products', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM contacts WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('contacts', v_n); v_total := v_total + v_n;

  -- ===== NEW: Categories (only after products) =====
  WITH d AS (DELETE FROM product_categories WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('product_categories', v_n); v_total := v_total + v_n;

  -- ===== NEW: Warehouses last; only delete sample warehouses with no real stock =====
  WITH d AS (
    DELETE FROM warehouses w
    WHERE w.organization_id = org_id
      AND w.is_sample_data
      AND NOT EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.warehouse_id = w.id)
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('warehouses', v_n); v_total := v_total + v_n;

  RETURN jsonb_build_object('success', true, 'totalDeleted', v_total, 'details', v_counts);
END;
$function$;