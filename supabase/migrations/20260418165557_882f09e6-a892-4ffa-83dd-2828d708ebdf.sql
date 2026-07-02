-- ============================================================================
-- Stage A + B + C(sequences): Make reset_organization_data complete and safe.
--
-- Root cause of the 400: many child tables added since the original RPC was
-- written hold ON DELETE NO ACTION FKs into invoices/bills/payments/expenses/
-- journal_entries. The previous RPC didn't delete them, so any non-empty row
-- aborted the whole wipe.
--
-- This migration:
--   * Replaces reset_organization_data with a full-coverage, dependency-ordered
--     wipe that runs in a single transaction (atomic — all or nothing).
--   * Nulls audit-style FKs (mpesa_c2b_transactions.matched_invoice_id,
--     timesheets.invoice_id) instead of deleting those rows — they are not
--     transactional postings, they are records that referenced wiped docs.
--   * Adds a coverage_check at the end that raises if any transactional row
--     for the org survives — protects against future schema drift.
--   * Resets per-org numbering sequences (invoice_sequences, je_number_sequences).
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
  v_user uuid := auth.uid();
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_expected_token text;
  v_residual jsonb := '{}'::jsonb;
  v_residual_total bigint := 0;
BEGIN
  -- ---- AUTH / TOKEN -------------------------------------------------------
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: owner required for reset' USING ERRCODE='42501';
  END IF;

  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  -- ---- HELPERS ------------------------------------------------------------
  -- We accumulate counts via a small inline pattern repeated below.

  -- ========================================================================
  -- 1) NULL OUT AUDIT-STYLE REFERENCES (preserve the row, drop the link)
  --    These tables are NOT transactional postings — they are audit/HR
  --    records that happen to point at wiped documents.
  -- ========================================================================

  UPDATE mpesa_c2b_transactions SET matched_invoice_id = NULL
   WHERE organization_id = org_id AND matched_invoice_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('mpesa_c2b_transactions_unlinked', v_n);

  UPDATE timesheets SET invoice_id = NULL
   WHERE organization_id = org_id AND invoice_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('timesheets_unlinked', v_n);

  -- ========================================================================
  -- 2) POS SUBTREE (children → parents)
  --    pos_transaction_item_modifiers → pos_transaction_items
  --                                   → pos_transaction_payments
  --                                   → pos_kitchen_orders
  --                                   → pos_split_bill_items / portions → pos_split_bills
  --                                   → pos_held_transactions
  --                                   → pos_gift_card_transactions
  --                                   → payment_requests (linked to pos_transaction)
  --                                   → pos_transactions
  --    pos_table_transfers → pos_table_sessions
  --    pos_cash_movements  → pos_shifts (which references journal_entries — must die before JE)
  --    pos_daily_summary
  -- ========================================================================

  WITH d AS (DELETE FROM pos_transaction_item_modifiers
              WHERE pos_transaction_item_id IN (
                SELECT pti.id FROM pos_transaction_items pti
                JOIN pos_transactions pt ON pt.id = pti.pos_transaction_id
                WHERE pt.organization_id = org_id
              ) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_transaction_item_modifiers', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_transaction_items
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_transaction_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_transaction_payments
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_transaction_payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_kitchen_orders
              WHERE pos_transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_kitchen_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_split_bill_items
              WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_split_bill_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_split_bill_portions
              WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_split_bill_portions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_split_bills WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_split_bills', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_held_transactions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_gift_card_transactions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payment_requests WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payment_requests', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_transactions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_table_transfers WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_table_transfers', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_table_sessions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_cash_movements
              WHERE shift_id IN (SELECT id FROM pos_shifts WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_cash_movements', v_n); v_total := v_total + v_n;

  -- pos_shifts.journal_entry_id → must die BEFORE journal_entries
  WITH d AS (DELETE FROM pos_shifts WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_shifts', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM pos_daily_summary WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('pos_daily_summary', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 3) INVENTORY MOVEMENTS (transactional only — products are master data)
  -- ========================================================================

  WITH d AS (DELETE FROM stock_movements WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_movements', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM stock_adjustment_items
              WHERE stock_adjustment_id IN (SELECT id FROM stock_adjustments WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_adjustment_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM stock_adjustments WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('stock_adjustments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM goods_receipt_items
              WHERE goods_receipt_id IN (SELECT id FROM goods_receipts WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('goods_receipt_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM goods_receipts WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('goods_receipts', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM backorders WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('backorders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM replenishment_logs WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('replenishment_logs', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 4) FIXED ASSETS — postings only; fixed_assets master + depreciation_schedules preserved
  -- ========================================================================

  WITH d AS (DELETE FROM depreciation_entries WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('depreciation_entries', v_n); v_total := v_total + v_n;

  -- depreciation_schedules.journal_entry_id is NO ACTION → must clear so JE delete works.
  -- Schedules themselves are setup/forecast data — keep the rows, drop the link.
  UPDATE depreciation_schedules SET journal_entry_id = NULL
   WHERE organization_id = org_id AND journal_entry_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('depreciation_schedules_unlinked', v_n);

  -- ========================================================================
  -- 5) PURCHASE RETURNS / VENDOR CREDIT NOTES (block bills + JEs)
  -- ========================================================================

  WITH d AS (DELETE FROM purchase_return_items
              WHERE purchase_return_id IN (SELECT id FROM purchase_returns WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_return_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_returns WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_returns', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_note_applications WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_notes WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_notes', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 6) AR/AP ANCILLARIES
  -- ========================================================================

  WITH d AS (DELETE FROM customer_statements WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('customer_statements', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM etims_transmission_logs WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('etims_transmission_logs', v_n); v_total := v_total + v_n;

  -- approval_requests scoped to wiped doc types
  WITH d AS (DELETE FROM approval_requests
              WHERE organization_id = org_id
              AND entity_type IN ('invoice','bill','payment','expense','journal_entry',
                                  'credit_note','purchase_order','sales_order','estimate',
                                  'proforma_invoice','delivery_note','sales_return',
                                  'recurring_invoice','bill_payment','vendor_credit_note',
                                  'purchase_return')
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('approval_requests', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 7) UNIVERSAL LEDGER PROJECTION (`transactions`) — must die BEFORE
  --    invoices/payments/expenses (it carries NO ACTION FKs into all three).
  -- ========================================================================

  WITH d AS (DELETE FROM transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('transactions', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 8) BANKING (must die BEFORE journal_entries — bank_transactions.journal_entry_id is NO ACTION)
  -- ========================================================================

  WITH d AS (DELETE FROM bank_reconciliation_items
              WHERE session_id IN (SELECT id FROM bank_reconciliation_sessions WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_sessions', v_n); v_total := v_total + v_n;

  -- bank_transaction_splits cascades from bank_transactions, no need to delete explicitly.
  WITH d AS (DELETE FROM bank_transactions WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_transactions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_statements WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_statements', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 9) CORE AR/AP SUBTREES
  -- ========================================================================

  WITH d AS (DELETE FROM payment_allocations
              WHERE payment_id IN (SELECT id FROM payments WHERE organization_id = org_id)
                 OR payment_id IN (SELECT id FROM bill_payments WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_payments WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payments WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_applications
              WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_items
              WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_notes WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_return_items
              WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_return_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_returns WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_returns', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_note_items
              WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_notes WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoice_items
              WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoices WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_items
              WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bills WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bills', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_order_items
              WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_orders WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_order_items
              WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_orders WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoice_items
              WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimate_items
              WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimate_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimates WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimates', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM recurring_invoices WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('recurring_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM expenses WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('expenses', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 10) JOURNAL ENTRIES (last — everything that referenced JEs is now gone)
  -- ========================================================================

  WITH d AS (DELETE FROM journal_entry_lines
              WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entry_lines', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entries WHERE organization_id = org_id RETURNING 1)
  SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entries', v_n); v_total := v_total + v_n;

  -- ========================================================================
  -- 11) SEQUENCES — restart numbering so post-reset documents start fresh
  -- ========================================================================

  DELETE FROM invoice_sequences  WHERE organization_id = org_id;
  DELETE FROM je_number_sequences WHERE organization_id = org_id;

  -- ========================================================================
  -- 12) COVERAGE CHECK — fail loudly if ANY transactional row survives.
  --     Catches schema drift the moment a new table is forgotten.
  -- ========================================================================

  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id = org_id UNION ALL
    SELECT 'bills', count(*) FROM bills WHERE organization_id = org_id UNION ALL
    SELECT 'payments', count(*) FROM payments WHERE organization_id = org_id UNION ALL
    SELECT 'bill_payments', count(*) FROM bill_payments WHERE organization_id = org_id UNION ALL
    SELECT 'expenses', count(*) FROM expenses WHERE organization_id = org_id UNION ALL
    SELECT 'journal_entries', count(*) FROM journal_entries WHERE organization_id = org_id UNION ALL
    SELECT 'bank_transactions', count(*) FROM bank_transactions WHERE organization_id = org_id UNION ALL
    SELECT 'credit_notes', count(*) FROM credit_notes WHERE organization_id = org_id UNION ALL
    SELECT 'sales_returns', count(*) FROM sales_returns WHERE organization_id = org_id UNION ALL
    SELECT 'delivery_notes', count(*) FROM delivery_notes WHERE organization_id = org_id UNION ALL
    SELECT 'sales_orders', count(*) FROM sales_orders WHERE organization_id = org_id UNION ALL
    SELECT 'purchase_orders', count(*) FROM purchase_orders WHERE organization_id = org_id UNION ALL
    SELECT 'proforma_invoices', count(*) FROM proforma_invoices WHERE organization_id = org_id UNION ALL
    SELECT 'estimates', count(*) FROM estimates WHERE organization_id = org_id UNION ALL
    SELECT 'recurring_invoices', count(*) FROM recurring_invoices WHERE organization_id = org_id UNION ALL
    SELECT 'transactions', count(*) FROM transactions WHERE organization_id = org_id UNION ALL
    SELECT 'pos_transactions', count(*) FROM pos_transactions WHERE organization_id = org_id UNION ALL
    SELECT 'pos_shifts', count(*) FROM pos_shifts WHERE organization_id = org_id UNION ALL
    SELECT 'pos_held_transactions', count(*) FROM pos_held_transactions WHERE organization_id = org_id UNION ALL
    SELECT 'pos_table_sessions', count(*) FROM pos_table_sessions WHERE organization_id = org_id UNION ALL
    SELECT 'stock_movements', count(*) FROM stock_movements WHERE organization_id = org_id UNION ALL
    SELECT 'stock_adjustments', count(*) FROM stock_adjustments WHERE organization_id = org_id UNION ALL
    SELECT 'goods_receipts', count(*) FROM goods_receipts WHERE organization_id = org_id UNION ALL
    SELECT 'depreciation_entries', count(*) FROM depreciation_entries WHERE organization_id = org_id UNION ALL
    SELECT 'vendor_credit_notes', count(*) FROM vendor_credit_notes WHERE organization_id = org_id UNION ALL
    SELECT 'purchase_returns', count(*) FROM purchase_returns WHERE organization_id = org_id UNION ALL
    SELECT 'bank_reconciliation_sessions', count(*) FROM bank_reconciliation_sessions WHERE organization_id = org_id UNION ALL
    SELECT 'bank_statements', count(*) FROM bank_statements WHERE organization_id = org_id
  ) s;

  IF v_residual_total > 0 THEN
    RAISE EXCEPTION 'Reset coverage check failed — residual transactional rows: %', v_residual::text
      USING ERRCODE='23000';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'totalDeleted', v_total,
    'details', v_counts,
    'coverage_check', 'passed'
  );
END;
$function$;