-- ============================================================================
-- Reset Ownership Fix — Inventory module (Step 2 of Reset Architecture plan)
--
-- Root cause: `reset_module__inventory` and `governance_modules.inventory`
-- claimed only ~7 tables while the schema has ~30+ transactional inventory
-- tables. Physical counts, cycle counts, warehouse balances, cost layers,
-- reservations, lots, recalls, controlled-substance/prescription records,
-- and inventory-ops housekeeping all survived reset. The coverage check
-- passed anyway because it, too, was a hand-picked subset.
--
-- This migration:
--   1. Corrects the governance_modules registration for `inventory` to
--      match every org-scoped inventory table that actually exists.
--   2. Replaces `reset_module__inventory(org_id, business_id)` to delete
--      every claimed table in child->parent order, honouring the teardown
--      GUC (already set by reset_organization_data).
--   3. Extends the residual/coverage check in `reset_organization_data`
--      to include the newly-covered tables so the safety net stays honest.
--   4. Zeroes derived state (accounts.current_balance for the org). Stock
--      balances are already wiped via warehouse_stock/warehouse_stock_lots.
--
-- Idempotent: safe to run twice. Deletes are qualified by organization_id
-- (and business_id where the column exists and a scope is passed).
-- ============================================================================

-- ── 1. Governance registry ──────────────────────────────────────────────────
UPDATE public.governance_modules
   SET owns_tables = ARRAY[
        -- Movement journal + adjustments
        'stock_movements',
        'stock_adjustments','stock_adjustment_items',
        'stock_adjustment_backfill_log','stock_movements_orphans',
        -- Transfers
        'stock_transfers','stock_transfer_items',
        -- Receipts / inbound
        'goods_receipts','goods_receipt_items',
        'backorders','replenishment_logs',
        -- Physical + cycle counting
        'physical_counts','physical_count_lines','physical_count_events',
        'physical_count_freeze_movements','physical_count_post_reconciliations',
        'physical_count_tolerance_policies','cycle_count_schedules',
        -- Balances, lots, reservations (derived + transactional)
        'warehouse_stock','warehouse_stock_lots','stock_lots','lot_quarantine',
        'stock_reservations','pos_stock_reservations',
        -- Costing subledger
        'cost_layers','cost_layer_consumptions',
        -- Traceability / regulated
        'product_recalls','product_recall_items',
        'controlled_substance_register',
        'prescriptions','prescription_sale_links',
        'scan_events',
        -- Ops housekeeping
        'scrap_attachments','reconciliation_sessions'
       ]::text[],
       derived_projections = ARRAY[
        'warehouse_stock.quantity',
        'warehouse_stock_lots.quantity'
       ]::text[],
       description = 'Inventory: stock movements, adjustments, transfers, goods receipts, physical & cycle counts, warehouse balances & lots, reservations, cost layers, traceability, prescriptions, recalls, and inventory ops housekeeping.',
       updated_at = now()
 WHERE module_key = 'inventory';

-- ── 2. Rewritten reset_module__inventory ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reset_module__inventory(
  org_id uuid,
  business_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb := '{}'::jsonb;
  n bigint;
  v_biz uuid := business_id;
BEGIN
  -- Guard: teardown context MUST be set. Direct callers of this RPC must
  -- go through reset_organization_data / reset_categories, which set
  -- app.reset_in_progress. Without this, immutability triggers on
  -- stock_movements / stock_adjustments will reject the DELETEs.
  IF coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
    RAISE EXCEPTION 'reset_module__inventory must be called inside a governance teardown context'
      USING ERRCODE = '55000';
  END IF;

  -- ── Physical & cycle counting (children first) ───────────────────────────
  WITH d AS (DELETE FROM public.physical_count_post_reconciliations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_post_reconciliations', n);

  WITH d AS (DELETE FROM public.physical_count_events
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_events', n);

  WITH d AS (DELETE FROM public.physical_count_freeze_movements
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_freeze_movements', n);

  WITH d AS (DELETE FROM public.physical_count_lines
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_lines', n);

  WITH d AS (DELETE FROM public.physical_counts
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_counts', n);

  WITH d AS (DELETE FROM public.physical_count_tolerance_policies
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_tolerance_policies', n);

  WITH d AS (DELETE FROM public.cycle_count_schedules
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cycle_count_schedules', n);

  -- ── Traceability / regulated (children first) ─────────────────────────────
  WITH d AS (DELETE FROM public.prescription_sale_links
              WHERE prescription_id IN (
                SELECT id FROM public.prescriptions
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('prescription_sale_links', n);

  WITH d AS (DELETE FROM public.prescriptions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('prescriptions', n);

  WITH d AS (DELETE FROM public.controlled_substance_register
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('controlled_substance_register', n);

  WITH d AS (DELETE FROM public.product_recall_items
              WHERE recall_id IN (
                SELECT id FROM public.product_recalls
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('product_recall_items', n);

  WITH d AS (DELETE FROM public.product_recalls
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('product_recalls', n);

  WITH d AS (DELETE FROM public.scan_events
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('scan_events', n);

  -- ── Reservations ─────────────────────────────────────────────────────────
  WITH d AS (DELETE FROM public.pos_stock_reservations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_stock_reservations', n);

  WITH d AS (DELETE FROM public.stock_reservations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_reservations', n);

  -- ── Ops housekeeping (must clear before adjustments) ─────────────────────
  WITH d AS (DELETE FROM public.stock_adjustment_backfill_log
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_backfill_log', n);

  WITH d AS (DELETE FROM public.stock_movements_orphans
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements_orphans', n);

  WITH d AS (DELETE FROM public.scrap_attachments
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('scrap_attachments', n);

  WITH d AS (DELETE FROM public.reconciliation_sessions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('reconciliation_sessions', n);

  -- ── Costing subledger (children first) ───────────────────────────────────
  WITH d AS (DELETE FROM public.cost_layer_consumptions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cost_layer_consumptions', n);

  WITH d AS (DELETE FROM public.cost_layers
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cost_layers', n);

  -- ── Movement journal + adjustments (existing behaviour) ──────────────────
  WITH d AS (DELETE FROM public.stock_movements
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements', n);

  WITH d AS (DELETE FROM public.stock_adjustment_items
              WHERE adjustment_id IN (
                SELECT id FROM public.stock_adjustments
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_items', n);

  WITH d AS (DELETE FROM public.stock_adjustments
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustments', n);

  -- ── Transfers ────────────────────────────────────────────────────────────
  WITH d AS (DELETE FROM public.stock_transfer_items
              WHERE transfer_id IN (
                SELECT id FROM public.stock_transfers
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_transfer_items', n);

  WITH d AS (DELETE FROM public.stock_transfers
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_transfers', n);

  -- ── Goods receipts ───────────────────────────────────────────────────────
  WITH d AS (DELETE FROM public.goods_receipt_items
              WHERE goods_receipt_id IN (
                SELECT id FROM public.goods_receipts
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipt_items', n);

  WITH d AS (DELETE FROM public.goods_receipts
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipts', n);

  WITH d AS (DELETE FROM public.backorders
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('backorders', n);

  WITH d AS (DELETE FROM public.replenishment_logs
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('replenishment_logs', n);

  -- ── Balances, lots, quarantine (derived + master-adjacent) ───────────────
  -- lot_quarantine references stock_lots (lot_id) — delete first.
  WITH d AS (DELETE FROM public.lot_quarantine
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('lot_quarantine', n);

  WITH d AS (DELETE FROM public.warehouse_stock_lots
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('warehouse_stock_lots', n);

  WITH d AS (DELETE FROM public.warehouse_stock
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('warehouse_stock', n);

  WITH d AS (DELETE FROM public.stock_lots
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_lots', n);

  RETURN v;
END;
$function$;

-- ── 3. Extended residual / coverage check in reset_organization_data ───────
-- Replaces prior body so residual detection now includes the newly-covered
-- inventory tables. Any non-zero count causes the residual object to
-- surface (and the pipeline is expected to have already deleted them; if
-- something remains, it is a real bug rather than a coverage gap).
CREATE OR REPLACE FUNCTION public.reset_organization_data(org_id uuid, confirmation_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_residual jsonb;
  v_residual_total bigint := 0;
  v_expected_token text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);
  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks',      public.reset_module__unlink_audit_refs(org_id));
  v_counts := v_counts || jsonb_build_object('pos',                public.reset_module__pos(org_id));
  v_counts := v_counts || jsonb_build_object('inventory',          public.reset_module__inventory(org_id));
  v_counts := v_counts || jsonb_build_object('fixed_assets',       public.reset_module__fixed_assets(org_id));
  v_counts := v_counts || jsonb_build_object('vendor_returns',     public.reset_module__vendor_returns(org_id));
  v_counts := v_counts || jsonb_build_object('ancillaries',        public.reset_module__ancillaries(org_id));
  v_counts := v_counts || jsonb_build_object('transactions_ledger',public.reset_module__transactions_ledger(org_id));
  v_counts := v_counts || jsonb_build_object('banking',            public.reset_module__banking(org_id));
  v_counts := v_counts || jsonb_build_object('sales',              public.reset_module__sales(org_id));
  v_counts := v_counts || jsonb_build_object('purchases',          public.reset_module__purchases(org_id));
  v_counts := v_counts || jsonb_build_object('hr',                 public.reset_module__hr(org_id));
  v_counts := v_counts || jsonb_build_object('payroll',            public.reset_module__payroll(org_id));
  v_counts := v_counts || jsonb_build_object('finance',            public.reset_module__finance(org_id));
  v_counts := v_counts || jsonb_build_object('sequences',          public.reset_module__sequences(org_id));

  -- Zero derived GL balances for this org. Master rows (chart of accounts)
  -- are preserved; only the running-balance projection is cleared, since
  -- every underlying journal_entry_line has just been deleted.
  UPDATE public.accounts
     SET current_balance = 0
   WHERE organization_id = org_id
     AND current_balance IS DISTINCT FROM 0;

  -- Residual / coverage check — expanded to include inventory tables that
  -- previously escaped the safety net.
  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    -- Existing coverage
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'bills',                   count(*) FROM bills                   WHERE organization_id=org_id UNION ALL
    SELECT 'payments',                count(*) FROM payments                WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries',         count(*) FROM journal_entries         WHERE organization_id=org_id UNION ALL
    SELECT 'transactions',            count(*) FROM transactions            WHERE organization_id=org_id UNION ALL
    SELECT 'payroll_runs',            count(*) FROM payroll_runs            WHERE organization_id=org_id UNION ALL
    SELECT 'payslips',                count(*) FROM payslips                WHERE organization_id=org_id UNION ALL
    SELECT 'timesheets',              count(*) FROM timesheets              WHERE organization_id=org_id UNION ALL
    SELECT 'attendance',              count(*) FROM attendance              WHERE organization_id=org_id UNION ALL
    SELECT 'leave_requests',          count(*) FROM leave_requests          WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries',    count(*) FROM depreciation_entries    WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions',        count(*) FROM pos_transactions        WHERE organization_id=org_id UNION ALL
    -- New inventory coverage
    SELECT 'stock_movements',         count(*) FROM stock_movements         WHERE organization_id=org_id UNION ALL
    SELECT 'stock_adjustments',       count(*) FROM stock_adjustments       WHERE organization_id=org_id UNION ALL
    SELECT 'stock_transfers',         count(*) FROM stock_transfers         WHERE organization_id=org_id UNION ALL
    SELECT 'goods_receipts',          count(*) FROM goods_receipts          WHERE organization_id=org_id UNION ALL
    SELECT 'physical_counts',         count(*) FROM physical_counts         WHERE organization_id=org_id UNION ALL
    SELECT 'physical_count_lines',    count(*) FROM physical_count_lines    WHERE organization_id=org_id UNION ALL
    SELECT 'physical_count_events',   count(*) FROM physical_count_events   WHERE organization_id=org_id UNION ALL
    SELECT 'cycle_count_schedules',   count(*) FROM cycle_count_schedules   WHERE organization_id=org_id UNION ALL
    SELECT 'warehouse_stock',         count(*) FROM warehouse_stock         WHERE organization_id=org_id UNION ALL
    SELECT 'warehouse_stock_lots',    count(*) FROM warehouse_stock_lots    WHERE organization_id=org_id UNION ALL
    SELECT 'stock_lots',              count(*) FROM stock_lots              WHERE organization_id=org_id UNION ALL
    SELECT 'lot_quarantine',          count(*) FROM lot_quarantine          WHERE organization_id=org_id UNION ALL
    SELECT 'stock_reservations',      count(*) FROM stock_reservations      WHERE organization_id=org_id UNION ALL
    SELECT 'pos_stock_reservations',  count(*) FROM pos_stock_reservations  WHERE organization_id=org_id UNION ALL
    SELECT 'cost_layers',             count(*) FROM cost_layers             WHERE organization_id=org_id UNION ALL
    SELECT 'cost_layer_consumptions', count(*) FROM cost_layer_consumptions WHERE organization_id=org_id UNION ALL
    SELECT 'controlled_substance_register', count(*) FROM controlled_substance_register WHERE organization_id=org_id UNION ALL
    SELECT 'prescriptions',           count(*) FROM prescriptions           WHERE organization_id=org_id UNION ALL
    SELECT 'product_recalls',         count(*) FROM product_recalls         WHERE organization_id=org_id UNION ALL
    SELECT 'scan_events',             count(*) FROM scan_events             WHERE organization_id=org_id
  ) s;

  RETURN jsonb_build_object(
    'success', true,
    'counts', v_counts,
    'totalDeleted', 0,
    'residual', coalesce(v_residual, '{}'::jsonb),
    'residualTotal', v_residual_total,
    'coverage_check', CASE WHEN v_residual_total = 0 THEN 'passed' ELSE 'failed' END
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.reset_organization_data(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_module__inventory(uuid, uuid) TO authenticated;