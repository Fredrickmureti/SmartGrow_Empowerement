-- ============================================================================
-- Stages D, E, F — Modular reset architecture, preview, transactional categories,
-- and storage-path collection.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: assert the caller is owner/super_admin of org_id.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assert_reset_permission(org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: owner required for reset' USING ERRCODE='42501';
  END IF;
END;
$$;

-- ============================================================================
-- PER-MODULE RESET FUNCTIONS
-- Each returns jsonb of {table: count}. None check permissions on their own —
-- the orchestrator (or reset_categories) does that once.
-- ============================================================================

-- --- POS ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM pos_transaction_item_modifiers
              WHERE pos_transaction_item_id IN (
                SELECT pti.id FROM pos_transaction_items pti
                JOIN pos_transactions pt ON pt.id = pti.pos_transaction_id
                WHERE pt.organization_id = org_id) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_item_modifiers', n);

  WITH d AS (DELETE FROM pos_transaction_items
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_items', n);

  WITH d AS (DELETE FROM pos_transaction_payments
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_payments', n);

  WITH d AS (DELETE FROM pos_kitchen_orders
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
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
$$;

-- --- INVENTORY ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__inventory(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM stock_movements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements', n);
  WITH d AS (DELETE FROM stock_adjustment_items
              WHERE stock_adjustment_id IN (SELECT id FROM stock_adjustments WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_items', n);
  WITH d AS (DELETE FROM stock_adjustments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustments', n);
  WITH d AS (DELETE FROM goods_receipt_items
              WHERE goods_receipt_id IN (SELECT id FROM goods_receipts WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipt_items', n);
  WITH d AS (DELETE FROM goods_receipts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipts', n);
  WITH d AS (DELETE FROM backorders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('backorders', n);
  WITH d AS (DELETE FROM replenishment_logs WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('replenishment_logs', n);
  RETURN v;
END;
$$;

-- --- FIXED ASSET POSTINGS ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__fixed_assets(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM depreciation_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('depreciation_entries', n);
  UPDATE depreciation_schedules SET journal_entry_id = NULL
   WHERE organization_id=org_id AND journal_entry_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  v := v || jsonb_build_object('depreciation_schedules_unlinked', n);
  RETURN v;
END;
$$;

-- --- VENDOR CREDIT NOTES + PURCHASE RETURNS (block bills + JEs) -------------
CREATE OR REPLACE FUNCTION public.reset_module__vendor_returns(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM purchase_return_items
              WHERE purchase_return_id IN (SELECT id FROM purchase_returns WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('purchase_return_items', n);
  WITH d AS (DELETE FROM purchase_returns WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('purchase_returns', n);
  WITH d AS (DELETE FROM vendor_credit_note_applications WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('vendor_credit_note_applications', n);
  WITH d AS (DELETE FROM vendor_credit_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('vendor_credit_notes', n);
  RETURN v;
END;
$$;

-- --- ANCILLARIES (statements, eTIMS, approvals, payment_requests) ------------
CREATE OR REPLACE FUNCTION public.reset_module__ancillaries(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM customer_statements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('customer_statements', n);
  WITH d AS (DELETE FROM etims_transmission_logs WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('etims_transmission_logs', n);
  WITH d AS (DELETE FROM payment_requests WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payment_requests', n);
  WITH d AS (DELETE FROM approval_requests
              WHERE organization_id=org_id
              AND entity_type IN ('invoice','bill','payment','expense','journal_entry',
                                  'credit_note','purchase_order','sales_order','estimate',
                                  'proforma_invoice','delivery_note','sales_return',
                                  'recurring_invoice','bill_payment','vendor_credit_note',
                                  'purchase_return') RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('approval_requests', n);
  RETURN v;
END;
$$;

-- --- AUDIT-REF UNLINKS (M-Pesa, timesheets) ---------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__unlink_audit_refs(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  UPDATE mpesa_c2b_transactions SET matched_invoice_id = NULL
   WHERE organization_id=org_id AND matched_invoice_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  v := v || jsonb_build_object('mpesa_c2b_transactions_unlinked', n);
  UPDATE timesheets SET invoice_id = NULL
   WHERE organization_id=org_id AND invoice_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  v := v || jsonb_build_object('timesheets_unlinked', n);
  RETURN v;
END;
$$;

-- --- BANKING -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__banking(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM bank_reconciliation_items
              WHERE session_id IN (SELECT id FROM bank_reconciliation_sessions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bank_reconciliation_items', n);
  WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bank_reconciliation_sessions', n);
  WITH d AS (DELETE FROM bank_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bank_transactions', n);
  WITH d AS (DELETE FROM bank_statements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bank_statements', n);
  RETURN v;
END;
$$;

-- --- UNIVERSAL LEDGER PROJECTION (must run BEFORE invoices/payments/expenses)
CREATE OR REPLACE FUNCTION public.reset_module__transactions_ledger(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n bigint;
BEGIN
  WITH d AS (DELETE FROM transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  RETURN jsonb_build_object('transactions', n);
END;
$$;

-- --- SALES (AR side) ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__sales(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  WITH d AS (DELETE FROM credit_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('credit_notes', n);
  WITH d AS (DELETE FROM sales_return_items
              WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_return_items', n);
  WITH d AS (DELETE FROM sales_returns WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_returns', n);
  WITH d AS (DELETE FROM delivery_note_items
              WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('delivery_note_items', n);
  WITH d AS (DELETE FROM delivery_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('delivery_notes', n);
  WITH d AS (DELETE FROM invoice_items
              WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('invoice_items', n);
  WITH d AS (DELETE FROM invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('invoices', n);
  WITH d AS (DELETE FROM sales_order_items
              WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_order_items', n);
  WITH d AS (DELETE FROM sales_orders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_orders', n);
  WITH d AS (DELETE FROM proforma_invoice_items
              WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoice_items', n);
  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoices', n);
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
$$;

-- --- PURCHASES (AP side) -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__purchases(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM payment_allocations
              WHERE payment_id IN (SELECT id FROM bill_payments WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('payment_allocations_ap', n);
  WITH d AS (DELETE FROM bill_payments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bill_payments', n);
  WITH d AS (DELETE FROM bill_items
              WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bill_items', n);
  WITH d AS (DELETE FROM bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bills', n);
  WITH d AS (DELETE FROM purchase_order_items
              WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('purchase_order_items', n);
  WITH d AS (DELETE FROM purchase_orders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('purchase_orders', n);
  WITH d AS (DELETE FROM expenses WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('expenses', n);
  RETURN v;
END;
$$;

-- --- FINANCE (journal entries) — runs LAST -----------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__finance(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM journal_entry_lines
              WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entry_lines', n);
  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entries', n);
  RETURN v;
END;
$$;

-- --- SEQUENCES ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_module__sequences(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n1 bigint; n2 bigint;
BEGIN
  DELETE FROM invoice_sequences  WHERE organization_id=org_id;
  GET DIAGNOSTICS n1 = ROW_COUNT;
  DELETE FROM je_number_sequences WHERE organization_id=org_id;
  GET DIAGNOSTICS n2 = ROW_COUNT;
  RETURN jsonb_build_object('invoice_sequences', n1, 'je_number_sequences', n2);
END;
$$;

-- ============================================================================
-- ORCHESTRATOR — replaces the monolithic reset_organization_data
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reset_organization_data(
  org_id uuid,
  confirmation_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_residual jsonb;
  v_residual_total bigint := 0;
  v_expected_token text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  -- Per-module deletes in dependency order
  v_counts := v_counts || jsonb_build_object('audit_unlinks',  public.reset_module__unlink_audit_refs(org_id));
  v_counts := v_counts || jsonb_build_object('pos',            public.reset_module__pos(org_id));
  v_counts := v_counts || jsonb_build_object('inventory',      public.reset_module__inventory(org_id));
  v_counts := v_counts || jsonb_build_object('fixed_assets',   public.reset_module__fixed_assets(org_id));
  v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
  v_counts := v_counts || jsonb_build_object('ancillaries',    public.reset_module__ancillaries(org_id));
  v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
  v_counts := v_counts || jsonb_build_object('banking',        public.reset_module__banking(org_id));
  v_counts := v_counts || jsonb_build_object('sales',          public.reset_module__sales(org_id));
  v_counts := v_counts || jsonb_build_object('purchases',      public.reset_module__purchases(org_id));
  v_counts := v_counts || jsonb_build_object('finance',        public.reset_module__finance(org_id));
  v_counts := v_counts || jsonb_build_object('sequences',      public.reset_module__sequences(org_id));

  -- COVERAGE CHECK — fail (and roll back) if anything transactional remains.
  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'bills', count(*) FROM bills WHERE organization_id=org_id UNION ALL
    SELECT 'payments', count(*) FROM payments WHERE organization_id=org_id UNION ALL
    SELECT 'bill_payments', count(*) FROM bill_payments WHERE organization_id=org_id UNION ALL
    SELECT 'expenses', count(*) FROM expenses WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries', count(*) FROM journal_entries WHERE organization_id=org_id UNION ALL
    SELECT 'bank_transactions', count(*) FROM bank_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'credit_notes', count(*) FROM credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_returns', count(*) FROM sales_returns WHERE organization_id=org_id UNION ALL
    SELECT 'delivery_notes', count(*) FROM delivery_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_orders', count(*) FROM sales_orders WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_orders', count(*) FROM purchase_orders WHERE organization_id=org_id UNION ALL
    SELECT 'proforma_invoices', count(*) FROM proforma_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'estimates', count(*) FROM estimates WHERE organization_id=org_id UNION ALL
    SELECT 'recurring_invoices', count(*) FROM recurring_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'transactions', count(*) FROM transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions', count(*) FROM pos_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_shifts', count(*) FROM pos_shifts WHERE organization_id=org_id UNION ALL
    SELECT 'pos_held_transactions', count(*) FROM pos_held_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_table_sessions', count(*) FROM pos_table_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'stock_movements', count(*) FROM stock_movements WHERE organization_id=org_id UNION ALL
    SELECT 'stock_adjustments', count(*) FROM stock_adjustments WHERE organization_id=org_id UNION ALL
    SELECT 'goods_receipts', count(*) FROM goods_receipts WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries', count(*) FROM depreciation_entries WHERE organization_id=org_id UNION ALL
    SELECT 'vendor_credit_notes', count(*) FROM vendor_credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_returns', count(*) FROM purchase_returns WHERE organization_id=org_id UNION ALL
    SELECT 'bank_reconciliation_sessions', count(*) FROM bank_reconciliation_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'bank_statements', count(*) FROM bank_statements WHERE organization_id=org_id
  ) s;

  IF v_residual_total > 0 THEN
    RAISE EXCEPTION 'Reset coverage check failed — residual transactional rows: %', v_residual::text
      USING ERRCODE='23000';
  END IF;

  -- Compute total deleted from leaf counts
  WITH leaves AS (
    SELECT (jsonb_each(module_obj.value)).value AS v
    FROM jsonb_each(v_counts) module_obj
    WHERE jsonb_typeof(module_obj.value) = 'object'
  )
  SELECT coalesce(sum((v)::bigint), 0) INTO v_total FROM leaves;

  RETURN jsonb_build_object(
    'success', true,
    'totalDeleted', v_total,
    'details', v_counts,
    'coverage_check', 'passed'
  );
END;
$function$;

-- ============================================================================
-- PREVIEW — returns counts that WOULD be wiped, no mutations.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.preview_organization_reset(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  SELECT jsonb_object_agg(t, c)
    INTO v
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'invoice_items', count(*) FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id) UNION ALL
    SELECT 'bills', count(*) FROM bills WHERE organization_id=org_id UNION ALL
    SELECT 'bill_items', count(*) FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id) UNION ALL
    SELECT 'payments', count(*) FROM payments WHERE organization_id=org_id UNION ALL
    SELECT 'bill_payments', count(*) FROM bill_payments WHERE organization_id=org_id UNION ALL
    SELECT 'expenses', count(*) FROM expenses WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries', count(*) FROM journal_entries WHERE organization_id=org_id UNION ALL
    SELECT 'bank_transactions', count(*) FROM bank_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'bank_statements', count(*) FROM bank_statements WHERE organization_id=org_id UNION ALL
    SELECT 'bank_reconciliation_sessions', count(*) FROM bank_reconciliation_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'credit_notes', count(*) FROM credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_returns', count(*) FROM sales_returns WHERE organization_id=org_id UNION ALL
    SELECT 'delivery_notes', count(*) FROM delivery_notes WHERE organization_id=org_id UNION ALL
    SELECT 'sales_orders', count(*) FROM sales_orders WHERE organization_id=org_id UNION ALL
    SELECT 'proforma_invoices', count(*) FROM proforma_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'estimates', count(*) FROM estimates WHERE organization_id=org_id UNION ALL
    SELECT 'recurring_invoices', count(*) FROM recurring_invoices WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_orders', count(*) FROM purchase_orders WHERE organization_id=org_id UNION ALL
    SELECT 'transactions', count(*) FROM transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions', count(*) FROM pos_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_shifts', count(*) FROM pos_shifts WHERE organization_id=org_id UNION ALL
    SELECT 'pos_held_transactions', count(*) FROM pos_held_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_table_sessions', count(*) FROM pos_table_sessions WHERE organization_id=org_id UNION ALL
    SELECT 'pos_split_bills', count(*) FROM pos_split_bills WHERE organization_id=org_id UNION ALL
    SELECT 'pos_gift_card_transactions', count(*) FROM pos_gift_card_transactions WHERE organization_id=org_id UNION ALL
    SELECT 'stock_movements', count(*) FROM stock_movements WHERE organization_id=org_id UNION ALL
    SELECT 'stock_adjustments', count(*) FROM stock_adjustments WHERE organization_id=org_id UNION ALL
    SELECT 'goods_receipts', count(*) FROM goods_receipts WHERE organization_id=org_id UNION ALL
    SELECT 'backorders', count(*) FROM backorders WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries', count(*) FROM depreciation_entries WHERE organization_id=org_id UNION ALL
    SELECT 'vendor_credit_notes', count(*) FROM vendor_credit_notes WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_returns', count(*) FROM purchase_returns WHERE organization_id=org_id UNION ALL
    SELECT 'customer_statements', count(*) FROM customer_statements WHERE organization_id=org_id UNION ALL
    SELECT 'etims_transmission_logs', count(*) FROM etims_transmission_logs WHERE organization_id=org_id UNION ALL
    SELECT 'payment_requests', count(*) FROM payment_requests WHERE organization_id=org_id UNION ALL
    SELECT 'mpesa_c2b_transactions_to_unlink', count(*) FROM mpesa_c2b_transactions WHERE organization_id=org_id AND matched_invoice_id IS NOT NULL UNION ALL
    SELECT 'timesheets_to_unlink', count(*) FROM timesheets WHERE organization_id=org_id AND invoice_id IS NOT NULL
  ) s
  WHERE c > 0;

  RETURN jsonb_build_object(
    'success', true,
    'preview', coalesce(v, '{}'::jsonb),
    'total', (SELECT coalesce(sum((value)::bigint), 0) FROM jsonb_each_text(coalesce(v, '{}'::jsonb)))
  );
END;
$$;

-- ============================================================================
-- TRANSACTIONAL CATEGORIES — replaces edge-fn safeRun loop
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reset_categories(
  org_id uuid,
  categories text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  cat text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  IF categories IS NULL OR cardinality(categories) = 0 THEN
    RAISE EXCEPTION 'No categories provided' USING ERRCODE='22023';
  END IF;

  -- Always run audit unlinks first — cheap and prevents FK blocks for any
  -- selection that touches invoices.
  v_counts := v_counts || jsonb_build_object('audit_unlinks', public.reset_module__unlink_audit_refs(org_id));

  FOREACH cat IN ARRAY categories LOOP
    IF cat = 'pos' THEN
      v_counts := v_counts || jsonb_build_object('pos', public.reset_module__pos(org_id));
    ELSIF cat = 'inventory' THEN
      v_counts := v_counts || jsonb_build_object('inventory', public.reset_module__inventory(org_id));
    ELSIF cat = 'fixed_assets' THEN
      v_counts := v_counts || jsonb_build_object('fixed_assets', public.reset_module__fixed_assets(org_id));
    ELSIF cat = 'vendor_returns' THEN
      v_counts := v_counts || jsonb_build_object('vendor_returns', public.reset_module__vendor_returns(org_id));
    ELSIF cat = 'ancillaries' THEN
      v_counts := v_counts || jsonb_build_object('ancillaries', public.reset_module__ancillaries(org_id));
    ELSIF cat = 'banking' THEN
      v_counts := v_counts || jsonb_build_object('banking', public.reset_module__banking(org_id));
    ELSIF cat = 'transactions_ledger' THEN
      v_counts := v_counts || jsonb_build_object('transactions_ledger', public.reset_module__transactions_ledger(org_id));
    ELSIF cat = 'sales' THEN
      v_counts := v_counts || jsonb_build_object('sales', public.reset_module__sales(org_id));
    ELSIF cat = 'purchases' THEN
      v_counts := v_counts || jsonb_build_object('purchases', public.reset_module__purchases(org_id));
    ELSIF cat = 'finance' THEN
      v_counts := v_counts || jsonb_build_object('finance', public.reset_module__finance(org_id));
    ELSIF cat = 'sequences' THEN
      v_counts := v_counts || jsonb_build_object('sequences', public.reset_module__sequences(org_id));
    ELSE
      RAISE EXCEPTION 'Unknown category: %', cat USING ERRCODE='22023';
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'details', v_counts);
END;
$function$;

-- ============================================================================
-- STORAGE PATH COLLECTION — read-only, returns paths the edge fn should purge
-- AFTER the DB transaction commits. Called BEFORE the wipe.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.list_org_storage_paths(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_receipts text[];
  v_doc_pdfs text[];
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  -- Expense receipts (column: receipt_url, may be a public URL or storage path)
  SELECT coalesce(array_agg(DISTINCT receipt_url) FILTER (WHERE receipt_url IS NOT NULL AND receipt_url <> ''), ARRAY[]::text[])
    INTO v_receipts
  FROM expenses WHERE organization_id=org_id;

  -- Generated PDFs for invoices/bills/credit_notes (table: documents.file_path with org_id)
  -- documents table holds generated artifacts; we only purge those whose source
  -- belongs to the wiped doc set. If documents has org_id we use it.
  SELECT coalesce(array_agg(DISTINCT file_path) FILTER (WHERE file_path IS NOT NULL AND file_path <> ''), ARRAY[]::text[])
    INTO v_doc_pdfs
  FROM documents WHERE organization_id=org_id;

  RETURN jsonb_build_object(
    'receipts', v_receipts,
    'document_pdfs', v_doc_pdfs
  );
END;
$$;

-- ============================================================================
-- GRANTS — these are SECURITY DEFINER but still need EXECUTE for authenticated role
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.reset_organization_data(uuid, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_organization_reset(uuid)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_categories(uuid, text[])              TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_org_storage_paths(uuid)                TO authenticated;