-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse (WMS) teardown module.
--
-- Before this migration NO reset module cleared wms_* execution data, which is
-- why receiving sessions survived a full "wipe all transactional data" run.
-- Master/config tables (warehouses, docks, zones, locations, tariffs,
-- packaging types, slotting/replen rules, hold reasons, counters, catalogs)
-- are intentionally preserved.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reset_module__warehouse(
  org_id uuid,
  p_business_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v        jsonb := '{}'::jsonb;
  n        bigint;
  t        text;
  v_pass   int;
  v_left   text[] := '{}';
  v_next   text[] := '{}';
  v_has_org boolean;
  v_has_biz boolean;
  v_where  text;
  v_sql    text;
  -- Child-before-parent order; the retry loop below absorbs any residual
  -- ordering surprises rather than hard-coding the full FK graph.
  v_tables text[] := ARRAY[
    'wms_qc_inspection_checks',
    'wms_qc_inspections',
    'wms_count_lines',
    'wms_count_sessions',
    'wms_manifest_cartons',
    'wms_loading_manifests',
    'wms_pick_wave_lines',
    'wms_pick_waves',
    'wms_pack_cartons',
    'wms_return_lines',
    'wms_return_orders',
    'wms_crossdock_opportunities',
    'wms_putaway_suggestions',
    'wms_tasks',
    'wms_billable_activities',
    'wms_packaging_events',
    'wms_client_scan_receipts',
    'wms_sscc_events',
    'wms_sscc_registry',
    'wms_lpn_events',
    'wms_receiving_lines',
    'wms_receiving_sessions',
    'wms_license_plates',
    'wms_exceptions',
    'wms_dock_appointments',
    'wms_trailer_visits'
  ];
BEGIN
  IF coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
    RAISE EXCEPTION 'reset_module__warehouse must be called inside a governance teardown context'
      USING ERRCODE = '55000';
  END IF;

  -- wms_qc_inspection_checks carries neither organization_id nor business_id;
  -- it is scoped through its parent inspection.
  IF to_regclass('public.wms_qc_inspection_checks') IS NOT NULL THEN
    EXECUTE $q$
      WITH d AS (
        DELETE FROM public.wms_qc_inspection_checks
         WHERE inspection_id IN (
           SELECT id FROM public.wms_qc_inspections
            WHERE organization_id = $1
              AND ($2 IS NULL OR business_id = $2)
         )
        RETURNING 1
      ) SELECT count(*) FROM d
    $q$ INTO n USING org_id, p_business_id;
    v := v || jsonb_build_object('wms_qc_inspection_checks', n);
  END IF;

  v_left := v_tables;

  FOR v_pass IN 1..4 LOOP
    v_next := '{}';
    FOREACH t IN ARRAY v_left LOOP
      IF t = 'wms_qc_inspection_checks' THEN
        CONTINUE;
      END IF;

      IF to_regclass('public.' || t) IS NULL THEN
        CONTINUE;
      END IF;

      SELECT bool_or(column_name = 'organization_id'),
             bool_or(column_name = 'business_id')
        INTO v_has_org, v_has_biz
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t;

      IF v_has_org AND v_has_biz THEN
        v_where := 'organization_id = $1 AND ($2 IS NULL OR business_id = $2)';
      ELSIF v_has_org THEN
        v_where := 'organization_id = $1 AND ($2 IS NULL OR $2 IS NOT NULL)';
      ELSIF v_has_biz THEN
        v_where := 'business_id IN (SELECT id FROM public.businesses WHERE organization_id = $1)'
                || ' AND ($2 IS NULL OR business_id = $2)';
      ELSE
        CONTINUE;
      END IF;

      v_sql := 'WITH d AS (DELETE FROM public.' || quote_ident(t)
            || ' WHERE ' || v_where || ' RETURNING 1) SELECT count(*) FROM d';

      BEGIN
        EXECUTE v_sql INTO n USING org_id, p_business_id;
        v := v || jsonb_build_object(t, coalesce((v->>t)::bigint, 0) + n);
      EXCEPTION WHEN foreign_key_violation THEN
        -- Something still points at these rows; retry on a later pass once
        -- the referencing table has been cleared.
        v_next := v_next || t;
      END;
    END LOOP;

    v_left := v_next;
    EXIT WHEN array_length(v_left, 1) IS NULL;
  END LOOP;

  IF array_length(v_left, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'reset_module__warehouse could not clear: %', array_to_string(v_left, ', ')
      USING ERRCODE = '23503';
  END IF;

  RETURN v;
END;
$fn$;

REVOKE ALL ON FUNCTION public.reset_module__warehouse(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reset_module__warehouse(uuid, uuid) TO authenticated, service_role;

-- ── Wire the module into the full wipe, ahead of inventory (WMS execution
--    rows reference products / locations that inventory-side cleanup touches).
CREATE OR REPLACE FUNCTION public.reset_organization_data(
  org_id uuid,
  confirmation_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
    -- Warehouse (WMS) execution coverage
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
    SELECT 'wms_trailer_visits',      count(*) FROM wms_trailer_visits      WHERE organization_id=org_id
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
$fn$;

-- ── Per-category wipe: accept the new 'warehouse' category.
CREATE OR REPLACE FUNCTION public.reset_categories(
  org_id uuid,
  categories text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  cat text;
BEGIN
  PERFORM public._assert_reset_permission(org_id);

  IF categories IS NULL OR cardinality(categories) = 0 THEN
    RAISE EXCEPTION 'No categories provided' USING ERRCODE='22023';
  END IF;

  PERFORM set_config('app.reset_in_progress', org_id::text, true);

  v_counts := v_counts || jsonb_build_object('audit_unlinks', public.reset_module__unlink_audit_refs(org_id));

  FOREACH cat IN ARRAY categories LOOP
    IF cat = 'pos' THEN
      v_counts := v_counts || jsonb_build_object('pos', public.reset_module__pos(org_id));
    ELSIF cat = 'warehouse' THEN
      v_counts := v_counts || jsonb_build_object('warehouse', public.reset_module__warehouse(org_id));
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
$fn$;

-- ── Register the module in the governance registry.
SELECT public.register_governance_module(
  'warehouse'::text,
  'Warehouse (WMS)'::text,
  ARRAY['inventory']::text[],
  ARRAY[
    'wms_receiving_sessions','wms_receiving_lines','wms_license_plates','wms_lpn_events',
    'wms_tasks','wms_pick_waves','wms_pick_wave_lines','wms_pack_cartons',
    'wms_loading_manifests','wms_manifest_cartons','wms_return_orders','wms_return_lines',
    'wms_qc_inspections','wms_qc_inspection_checks','wms_count_sessions','wms_count_lines',
    'wms_exceptions','wms_dock_appointments','wms_trailer_visits',
    'wms_crossdock_opportunities','wms_putaway_suggestions','wms_sscc_registry','wms_sscc_events',
    'wms_client_scan_receipts','wms_billable_activities','wms_packaging_events'
  ]::text[],
  '[]'::jsonb,
  ARRAY[]::text[],
  ARRAY[]::text[],
  'reset_module__warehouse'::text,
  NULL::text,
  NULL::text,
  1,
  'Warehouse execution records: receiving sessions and lines, licence plates, tasks, waves, cartons, manifests, returns, QC inspections, counts, exceptions, appointments, trailer visits, cross-dock and putaway suggestions. Warehouse, dock, zone, location and rule master data is preserved.'::text
);
