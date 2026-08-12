
-- 1) Allow teardown to remove append-only credit movements
CREATE OR REPLACE FUNCTION public._ccm_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND public._is_teardown_for_org(OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'customer_credit_movements is append-only';
END;
$function$;

-- 2) Sales module: clear customer credit ledger + refunds before their parents
CREATE OR REPLACE FUNCTION public.reset_module__sales(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  -- Customer credit ledger first: it RESTRICT-references credit_notes,
  -- invoices, payments and customer_refunds.
  WITH d AS (DELETE FROM customer_credit_movements ccm
              WHERE ccm.organization_id = reset_module__sales.org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('customer_credit_movements', n);

  WITH d AS (DELETE FROM customer_refunds cr
              WHERE cr.organization_id = reset_module__sales.org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('customer_refunds', n);

  WITH d AS (DELETE FROM customer_credit_balances ccb
              WHERE ccb.organization_id = reset_module__sales.org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('customer_credit_balances', n);

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

  WITH d AS (DELETE FROM proforma_invoice_items
              WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoice_items', n);

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('proforma_invoices', n);

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

-- 3) Residual coverage: include the AR credit chain
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
