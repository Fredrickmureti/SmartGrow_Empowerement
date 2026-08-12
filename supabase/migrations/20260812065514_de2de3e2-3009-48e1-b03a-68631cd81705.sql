-- 1) Fix 42702: bare `org_id` on the left of the predicate collides with the
--    function parameter of the same name on tables whose tenant column is
--    literally `org_id`. Qualify BOTH sides.
CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.pos_split_bill_items') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_items
       WHERE portion_id IN (
         SELECT p.id FROM pos_split_bill_portions p
         JOIN pos_split_bills b ON b.id = p.split_bill_id
         WHERE b.organization_id = org_id
       )
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_items', n);
  END IF;

  IF to_regclass('public.pos_split_bill_portions') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_portions
       WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id = org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_portions', n);
  END IF;

  IF to_regclass('public.pos_split_bills') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bills', n);
  END IF;

  IF to_regclass('public.pos_kitchen_tickets') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_tickets WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_tickets', n);
  END IF;

  IF to_regclass('public.pos_kitchen_orders') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_orders WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_orders', n);
  END IF;

  IF to_regclass('public.pos_table_sessions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_table_sessions', n);
  END IF;

  IF to_regclass('public.pos_gift_card_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_gift_card_transactions', n);
  END IF;

  IF to_regclass('public.pos_held_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_held_transactions', n);
  END IF;

  IF to_regclass('public.pos_transaction_items') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transaction_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transaction_items', n);
  END IF;

  IF to_regclass('public.pos_transactions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transactions', n);
  END IF;

  -- Ledger aggregates that FK to pos_shifts with ON DELETE RESTRICT.
  IF to_regclass('public.pos_statements') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_statements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_statements', n);
  END IF;

  IF to_regclass('public.pos_shifts') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_shifts', n);
  END IF;

  IF to_regclass('public.cashier_registers') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM cashier_registers WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('cashier_registers', n);
  END IF;

  -- Posting-engine projections of the POS documents deleted above.
  -- NOTE: these tables key the tenant on a column literally named `org_id`,
  -- which collides with this function's parameter. Both sides MUST be
  -- qualified or PL/pgSQL raises 42702 (column reference "org_id" is
  -- ambiguous) — the regression that broke tenant reset entirely.
  -- The stored key is sometimes the organization id and sometimes the
  -- business id, so match either.
  IF to_regclass('public.accounting_events') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM accounting_events ae
       WHERE (ae.org_id = reset_module__pos.org_id
              OR ae.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__pos.org_id))
         AND ae.producer = 'pos'
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('accounting_events', n);
  END IF;

  IF to_regclass('public.business_event_outbox') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox o
       WHERE (o.org_id = reset_module__pos.org_id
              OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__pos.org_id))
         AND o.source_doc_type IN ('pos_transaction','pos_shift','pos_statement',
                                   'pos_payment_session','pos_split_bill')
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox', n);
  END IF;

  IF to_regclass('public.business_event_outbox_dead') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox_dead o
       WHERE (o.org_id = reset_module__pos.org_id
              OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__pos.org_id))
         AND o.source_doc_type IN ('pos_transaction','pos_shift','pos_statement',
                                   'pos_payment_session','pos_split_bill')
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox_dead', n);
  END IF;

  RETURN v;
END;
$function$;

-- 2) New module: sweep ALL posting-engine projections / event queues for the
--    tenant, regardless of producer. These are projections of transactional
--    documents, never configuration.
CREATE OR REPLACE FUNCTION public.reset_module__events(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.accounting_events') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM accounting_events ae
       WHERE ae.org_id = reset_module__events.org_id
          OR ae.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__events.org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('accounting_events', n);
  END IF;

  IF to_regclass('public.business_event_outbox') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox o
       WHERE o.org_id = reset_module__events.org_id
          OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__events.org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox', n);
  END IF;

  IF to_regclass('public.business_event_outbox_dead') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM business_event_outbox_dead o
       WHERE o.org_id = reset_module__events.org_id
          OR o.org_id IN (SELECT b.id FROM businesses b WHERE b.organization_id = reset_module__events.org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('business_event_outbox_dead', n);
  END IF;

  RETURN v;
END;
$function$;

REVOKE ALL ON FUNCTION public.reset_module__events(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_module__events(uuid) TO authenticated, service_role;

-- 3) Orchestrator: run the events sweep after every document module and add
--    the three tables to the residual coverage check.
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
  -- Posting-engine projections & event queues last: every document module
  -- above may emit outbox rows while it runs.
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
    SELECT 'wms_trailer_visits',      count(*) FROM wms_trailer_visits      WHERE organization_id=org_id UNION ALL
    -- Posting-engine projections / event queues (tenant column is `org_id`,
    -- holding either the organization id or one of its business ids).
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