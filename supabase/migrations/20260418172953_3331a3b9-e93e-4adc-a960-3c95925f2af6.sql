
-- =============================================================
-- Org Data Reset — fix critical defects in reset modules
-- =============================================================
-- 1. reset_module__pos: wrong column refs (pos_transaction_id → transaction_id)
-- 2. reset_module__sales: FK ordering blockers (sales_returns/credit_notes,
--    invoices/proforma_invoices, invoices/sales_orders)
-- 3. reset_module__finance: neutralize self-FK on journal_entries.reversed_entry_id
-- 4. _assert_reset_permission: include user/org in failure message for diagnosis
-- =============================================================

-- -------------------------------------------------------------
-- FIX 1: reset_module__pos — use correct child column name
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  -- pos_transaction_item_modifiers (child of pos_transaction_items)
  WITH d AS (DELETE FROM pos_transaction_item_modifiers
              WHERE transaction_item_id IN (
                SELECT pti.id FROM pos_transaction_items pti
                JOIN pos_transactions pt ON pt.id = pti.transaction_id
                WHERE pt.organization_id = org_id) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_item_modifiers', n);

  -- pos_transaction_items (child of pos_transactions via transaction_id)
  WITH d AS (DELETE FROM pos_transaction_items
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_items', n);

  -- pos_transaction_payments (child of pos_transactions via transaction_id)
  WITH d AS (DELETE FROM pos_transaction_payments
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_payments', n);

  -- pos_kitchen_orders (transaction_id per actual schema)
  WITH d AS (DELETE FROM pos_kitchen_orders
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_kitchen_orders', n);

  WITH d AS (DELETE FROM pos_split_bill_items
              WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bill_items', n);

  WITH d AS (DELETE FROM pos_split_bill_portions
              WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bill_portions', n);

  WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bills', n);
  WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_held_transactions', n);
  WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_gift_card_transactions', n);
  WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transactions', n);
  WITH d AS (DELETE FROM pos_table_transfers WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_table_transfers', n);
  WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_table_sessions', n);
  WITH d AS (DELETE FROM pos_cash_movements
              WHERE shift_id IN (SELECT id FROM pos_shifts WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_cash_movements', n);
  WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_shifts', n);
  WITH d AS (DELETE FROM pos_daily_summary WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_daily_summary', n);
  RETURN v;
END;
$function$;

-- -------------------------------------------------------------
-- FIX 2: reset_module__sales — corrected FK-safe deletion order
-- Order rationale (children → parents, respecting NO ACTION FKs):
--   payment_allocations → payments
--   credit_note_applications → credit_note_items
--   sales_return_items → sales_returns       (BEFORE credit_notes — sales_returns.credit_note_id = NO ACTION)
--   credit_notes
--   delivery_note_items → delivery_notes
--   proforma_invoice_items → proforma_invoices  (BEFORE invoices — proforma.converted_invoice_id = NO ACTION)
--   sales_order_items → sales_orders         (BEFORE invoices — sales_orders.converted_invoice_id = NO ACTION)
--   invoice_items → invoices
--   estimate_items → estimates               (AFTER sales_orders — sales_orders.source_estimate_id)
--   recurring_invoices
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__sales(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM payment_allocations
              WHERE payment_id IN (SELECT id FROM payments WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payment_allocations_ar', n);

  WITH d AS (DELETE FROM payments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payments', n);

  WITH d AS (DELETE FROM credit_note_applications
              WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('credit_note_applications', n);

  WITH d AS (DELETE FROM credit_note_items
              WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('credit_note_items', n);

  -- Sales returns BEFORE credit_notes (sales_returns.credit_note_id is NO ACTION)
  WITH d AS (DELETE FROM sales_return_items
              WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_return_items', n);

  WITH d AS (DELETE FROM sales_returns WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_returns', n);

  WITH d AS (DELETE FROM credit_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('credit_notes', n);

  WITH d AS (DELETE FROM delivery_note_items
              WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('delivery_note_items', n);

  WITH d AS (DELETE FROM delivery_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('delivery_notes', n);

  -- Proforma BEFORE invoices (proforma_invoices.converted_invoice_id is NO ACTION)
  WITH d AS (DELETE FROM proforma_invoice_items
              WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoice_items', n);

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoices', n);

  -- Sales orders BEFORE invoices (sales_orders.converted_invoice_id is NO ACTION)
  WITH d AS (DELETE FROM sales_order_items
              WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_order_items', n);

  WITH d AS (DELETE FROM sales_orders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_orders', n);

  WITH d AS (DELETE FROM invoice_items
              WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('invoice_items', n);

  WITH d AS (DELETE FROM invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('invoices', n);

  -- Estimates AFTER sales_orders (sales_orders.source_estimate_id)
  WITH d AS (DELETE FROM estimate_items
              WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('estimate_items', n);

  WITH d AS (DELETE FROM estimates WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('estimates', n);

  WITH d AS (DELETE FROM recurring_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('recurring_invoices', n);
  RETURN v;
END;
$function$;

-- -------------------------------------------------------------
-- FIX 3: reset_module__finance — neutralize self-referential FK
-- (journal_entries.reversed_entry_id → journal_entries.id)
-- before bulk-deleting the journal entries themselves.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__finance(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  -- Null self-FK first to avoid order-of-deletion issues within the bulk delete
  UPDATE journal_entries
     SET reversed_entry_id = NULL
   WHERE organization_id = org_id
     AND reversed_entry_id IS NOT NULL;

  WITH d AS (DELETE FROM journal_entry_lines
              WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entry_lines', n);

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entries', n);
  RETURN v;
END;
$function$;

-- -------------------------------------------------------------
-- FIX 4: _assert_reset_permission — diagnostic detail in error
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assert_reset_permission(org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required (no auth.uid in session) for org %', org_id
      USING ERRCODE='42501';
  END IF;
  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: user % is not owner/super_admin of org %', v_user, org_id
      USING ERRCODE='42501';
  END IF;
END;
$function$;
