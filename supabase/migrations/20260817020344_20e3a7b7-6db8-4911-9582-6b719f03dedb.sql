CREATE OR REPLACE FUNCTION public.reset_module__costing(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
    RAISE EXCEPTION 'reset_module__costing must be called inside a governance teardown context'
      USING ERRCODE = '55000';
  END IF;

  -- Costing detail that pins cost_layers / cost_layer_consumptions (ON DELETE RESTRICT)
  WITH d AS (DELETE FROM public.sales_return_cost_allocations
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('sales_return_cost_allocations', n);

  WITH d AS (DELETE FROM public.inventory_cost_revaluations
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('inventory_cost_revaluations', n);

  WITH d AS (DELETE FROM public.cost_layer_lineage
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cost_layer_lineage', n);

  -- Three-way matching + landed cost, all of which pin goods_receipts /
  -- goods_receipt_items (ON DELETE RESTRICT) cleared by reset_module__inventory.
  WITH d AS (DELETE FROM public.bill_grn_matches
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bill_grn_matches', n);

  WITH d AS (DELETE FROM public.bill_match_exceptions
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bill_match_exceptions', n);

  WITH d AS (DELETE FROM public.bill_match_results
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('bill_match_results', n);

  WITH d AS (DELETE FROM public.landed_cost_allocations
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('landed_cost_allocations', n);

  WITH d AS (DELETE FROM public.landed_cost_voucher_receipts
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('landed_cost_voucher_receipts', n);

  -- cascades to landed_cost_components / remaining allocations
  WITH d AS (DELETE FROM public.landed_cost_vouchers
              WHERE organization_id = org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('landed_cost_vouchers', n);

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.reset_module__costing(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reset_organization_data(org_id uuid, confirmation_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_counts := v_counts || jsonb_build_object('warehouse',          public.reset_module__warehouse(org_id));
  -- Must precede inventory: these hold RESTRICT references to cost_layers,
  -- cost_layer_consumptions, goods_receipts and goods_receipt_items.
  v_counts := v_counts || jsonb_build_object('costing',            public.reset_module__costing(org_id));
  v_counts := v_counts || jsonb_build_object('vendor_returns',     public.reset_module__vendor_returns(org_id));
  v_counts := v_counts || jsonb_build_object('inventory',          public.reset_module__inventory(org_id));
  v_counts := v_counts || jsonb_build_object('fixed_assets',       public.reset_module__fixed_assets(org_id));
  v_counts := v_counts || jsonb_build_object('ancillaries',        public.reset_module__ancillaries(org_id));
  v_counts := v_counts || jsonb_build_object('transactions_ledger',public.reset_module__transactions_ledger(org_id));
  v_counts := v_counts || jsonb_build_object('banking',            public.reset_module__banking(org_id));
  v_counts := v_counts || jsonb_build_object('sales',              public.reset_module__sales(org_id));
  v_counts := v_counts || jsonb_build_object('purchases',          public.reset_module__purchases(org_id));
  v_counts := v_counts || jsonb_build_object('hr',                 public.reset_module__hr(org_id));
  v_counts := v_counts || jsonb_build_object('payroll',            public.reset_module__payroll(org_id));
  v_counts := v_counts || jsonb_build_object('finance',            public.reset_module__finance(org_id));
  v_counts := v_counts || jsonb_build_object('events',             public.reset_module__events(org_id));
  v_counts := v_counts || jsonb_build_object('sequences',          public.reset_module__sequences(org_id));

  UPDATE public.accounts
     SET current_balance = 0
   WHERE organization_id = org_id
     AND current_balance IS DISTINCT FROM 0;

  SELECT coalesce(sum(c), 0), jsonb_object_agg(t, c) FILTER (WHERE c > 0)
    INTO v_residual_total, v_residual
  FROM (
    SELECT 'invoices' t, count(*) c FROM invoices WHERE organization_id=org_id UNION ALL
    SELECT 'bills',                   count(*) FROM bills                   WHERE organization_id=org_id UNION ALL
    SELECT 'payments',                count(*) FROM payments                WHERE organization_id=org_id UNION ALL
    SELECT 'credit_notes',            count(*) FROM credit_notes            WHERE organization_id=org_id UNION ALL
    SELECT 'customer_credit_movements', count(*) FROM customer_credit_movements WHERE organization_id=org_id UNION ALL
    SELECT 'customer_credit_balances',  count(*) FROM customer_credit_balances  WHERE organization_id=org_id UNION ALL
    SELECT 'customer_refunds',         count(*) FROM customer_refunds        WHERE organization_id=org_id UNION ALL
    SELECT 'journal_entries',         count(*) FROM journal_entries         WHERE organization_id=org_id UNION ALL
    SELECT 'transactions',            count(*) FROM transactions            WHERE organization_id=org_id UNION ALL
    SELECT 'payroll_runs',            count(*) FROM payroll_runs            WHERE organization_id=org_id UNION ALL
    SELECT 'payslips',                count(*) FROM payslips                WHERE organization_id=org_id UNION ALL
    SELECT 'timesheets',              count(*) FROM timesheets              WHERE organization_id=org_id UNION ALL
    SELECT 'attendance',              count(*) FROM attendance              WHERE organization_id=org_id UNION ALL
    SELECT 'leave_requests',          count(*) FROM leave_requests          WHERE organization_id=org_id UNION ALL
    SELECT 'depreciation_entries',    count(*) FROM depreciation_entries    WHERE organization_id=org_id UNION ALL
    SELECT 'pos_transactions',        count(*) FROM pos_transactions        WHERE organization_id=org_id UNION ALL
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
    SELECT 'cost_layer_lineage',      count(*) FROM cost_layer_lineage      WHERE organization_id=org_id UNION ALL
    SELECT 'inventory_cost_revaluations', count(*) FROM inventory_cost_revaluations WHERE organization_id=org_id UNION ALL
    SELECT 'sales_return_cost_allocations', count(*) FROM sales_return_cost_allocations WHERE organization_id=org_id UNION ALL
    SELECT 'bill_grn_matches',        count(*) FROM bill_grn_matches        WHERE organization_id=org_id UNION ALL
    SELECT 'bill_match_results',      count(*) FROM bill_match_results      WHERE organization_id=org_id UNION ALL
    SELECT 'bill_match_exceptions',   count(*) FROM bill_match_exceptions   WHERE organization_id=org_id UNION ALL
    SELECT 'landed_cost_vouchers',    count(*) FROM landed_cost_vouchers    WHERE organization_id=org_id UNION ALL
    SELECT 'landed_cost_allocations', count(*) FROM landed_cost_allocations WHERE organization_id=org_id UNION ALL
    SELECT 'landed_cost_voucher_receipts', count(*) FROM landed_cost_voucher_receipts WHERE organization_id=org_id UNION ALL
    SELECT 'purchase_returns',        count(*) FROM purchase_returns        WHERE organization_id=org_id UNION ALL
    SELECT 'controlled_substance_register', count(*) FROM controlled_substance_register WHERE organization_id=org_id UNION ALL
    SELECT 'prescriptions',           count(*) FROM prescriptions           WHERE organization_id=org_id UNION ALL
    SELECT 'product_recalls',         count(*) FROM product_recalls         WHERE organization_id=org_id UNION ALL
    SELECT 'scan_events',             count(*) FROM scan_events             WHERE organization_id=org_id UNION ALL
    SELECT 'wms_receiving_sessions',  count(*) FROM wms_receiving_sessions  WHERE organization_id=org_id UNION ALL
    SELECT 'wms_receiving_lines',     count(*) FROM wms_receiving_lines     WHERE organization_id=org_id UNION ALL
    SELECT 'wms_tasks',               count(*) FROM wms_tasks               WHERE organization_id=org_id UNION ALL
    SELECT 'wms_license_plates',      count(*) FROM wms_license_plates      WHERE organization_id=org_id UNION ALL
    SELECT 'wms_exceptions',          count(*) FROM wms_exceptions          WHERE organization_id=org_id UNION ALL
    SELECT 'wms_dock_appointments',   count(*) FROM wms_dock_appointments   WHERE organization_id=org_id UNION ALL
    SELECT 'wms_pick_waves',          count(*) FROM wms_pick_waves          WHERE organization_id=org_id UNION ALL
    SELECT 'wms_loading_manifests',   count(*) FROM wms_loading_manifests   WHERE organization_id=org_id UNION ALL
    SELECT 'wms_qc_inspections',      count(*) FROM wms_qc_inspections      WHERE organization_id=org_id UNION ALL
    SELECT 'wms_count_sessions',      count(*) FROM wms_count_sessions      WHERE organization_id=org_id UNION ALL
    SELECT 'wms_return_orders',       count(*) FROM wms_return_orders       WHERE organization_id=org_id UNION ALL
    SELECT 'wms_trailer_visits',      count(*) FROM wms_trailer_visits      WHERE organization_id=org_id UNION ALL
    SELECT 'accounting_events',       count(*) FROM accounting_events ae
      WHERE ae.org_id = reset_organization_data.org_id
         OR ae.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_organization_data.org_id) UNION ALL
    SELECT 'business_event_outbox',   count(*) FROM business_event_outbox o
      WHERE o.org_id = reset_organization_data.org_id
         OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_organization_data.org_id) UNION ALL
    SELECT 'business_event_outbox_dead', count(*) FROM business_event_outbox_dead o
      WHERE o.org_id = reset_organization_data.org_id
         OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_organization_data.org_id)
  ) s;

  RETURN jsonb_build_object(
    'success', true,
    'counts', v_counts,
    'totalDeleted', 0,
    'residual', coalesce(v_residual, '{}'::jsonb),
    'residualTotal', v_residual_total,
    'coverage_check', CASE WHEN v_residual_total = 0 THEN 'passed' ELSE 'failed' END
  );
END;
$function$;