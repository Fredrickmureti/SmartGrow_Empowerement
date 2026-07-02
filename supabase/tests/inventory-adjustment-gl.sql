-- pgTAP contract tests for ADR 0016 — Inventory Adjustment ↔ GL Integrity.
--
-- Run via:  pg_prove -d "$DATABASE_URL" supabase/tests/inventory-adjustment-gl.sql
--
-- Schema/signature/source-level assertions only. End-to-end behavioural
-- cases (idempotency replay, reversal round-trip nets to zero,
-- double-reverse raises, locked-period raises) require a seeded org
-- fixture and ship from `supabase/tests/e2e/` when that fixture lands.
BEGIN;
SELECT plan(27);

-- ============== Invariant 1: cost resolver + raise ==============

SELECT has_function(
  'public', 'resolve_adjustment_unit_cost',
  ARRAY['uuid','uuid','uuid','uuid','numeric'],
  'resolve_adjustment_unit_cost(org, business, product, warehouse, provided) exists'
);

SELECT has_function(
  'public', 'approve_stock_adjustment_atomic',
  ARRAY['uuid','uuid'],
  'approve_stock_adjustment_atomic(adjustment_id, user_id) exists'
);

-- Source-level assertion that the RPC raises when no cost is resolvable.
SELECT ok(
  (SELECT prosrc ILIKE '%no valuation cost is available for product%'
     FROM pg_proc
    WHERE proname = 'approve_stock_adjustment_atomic'
    LIMIT 1),
  'approve_stock_adjustment_atomic raises on missing cost'
);

-- ============== Invariant 2: immutability of approved rows ==============

SELECT has_function(
  'public', 'prevent_approved_adjustment_mutation',
  'immutability trigger function exists'
);

SELECT has_trigger(
  'public', 'stock_adjustments',
  'trg_prevent_approved_adjustment_mutation',
  'immutability trigger is attached to stock_adjustments'
);

-- ============== Invariant 3: reversal RPC + linkage columns ==============

SELECT has_function(
  'public', 'reverse_stock_adjustment_atomic',
  ARRAY['uuid','uuid','text','uuid'],
  'reverse_stock_adjustment_atomic(adjustment_id, user_id, reason, client_request_id) exists'
);

SELECT has_column(
  'public', 'stock_adjustments', 'reverses_adjustment_id',
  'stock_adjustments.reverses_adjustment_id exists'
);

SELECT has_column(
  'public', 'stock_adjustments', 'reversed_by_adjustment_id',
  'stock_adjustments.reversed_by_adjustment_id exists'
);

-- ============== Idempotency + AVCO + backfill surface ==============

SELECT has_column(
  'public', 'stock_adjustments', 'client_request_id',
  'stock_adjustments.client_request_id exists for idempotency'
);

SELECT has_column(
  'public', 'warehouse_stock', 'average_cost',
  'warehouse_stock.average_cost exists for per-warehouse AVCO'
);

SELECT has_function(
  'public', 'backfill_missing_adjustment_je',
  ARRAY['uuid','uuid'],
  'backfill_missing_adjustment_je(adjustment_id, user_id) exists for legacy cleanup'
);

-- ============== Behavioural source-level assertions ==============

SELECT ok(
  (SELECT prosrc ILIKE '%post_journal_entry_atomic%'
     FROM pg_proc WHERE proname = 'approve_stock_adjustment_atomic' LIMIT 1),
  'approve_stock_adjustment_atomic routes JE posting through post_journal_entry_atomic'
);

SELECT ok(
  (SELECT prosrc ILIKE '%client_request_id%'
     FROM pg_proc WHERE proname = 'apply_or_request_stock_adjustment' LIMIT 1),
  'apply_or_request_stock_adjustment short-circuits on duplicate client_request_id'
);

SELECT ok(
  (SELECT prosrc ILIKE '%already reversed%'
     FROM pg_proc WHERE proname = 'reverse_stock_adjustment_atomic' LIMIT 1),
  'reverse_stock_adjustment_atomic refuses to reverse an already-reversed adjustment'
);

SELECT ok(
  (SELECT prosrc ILIKE '%accounting period is locked%'
     OR   prosrc ILIKE '%period is locked%'
     OR   prosrc ILIKE '%posting is locked%'
     OR   prosrc ILIKE '%period_lock%'
     FROM pg_proc WHERE proname = 'reverse_stock_adjustment_atomic' LIMIT 1),
  'reverse_stock_adjustment_atomic respects accounting period locks'
);

-- ============== Wave 5 — preview RPC + backfill audit log ==============

SELECT has_function(
  'public', 'preview_adjustment_offset_account',
  ARRAY['uuid','text','integer'],
  'preview_adjustment_offset_account(business, reason, sign) exists for the dialog hint'
);

SELECT has_table(
  'public', 'stock_adjustment_backfill_log',
  'stock_adjustment_backfill_log audit table exists'
);

SELECT ok(
  (SELECT prosrc ILIKE '%stock_adjustment_backfill_log%'
     FROM pg_proc WHERE proname = 'backfill_missing_adjustment_je' LIMIT 1),
  'backfill_missing_adjustment_je writes an audit row in the same transaction'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'stock_adjustment_backfill_log'
       AND cmd        = 'SELECT'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'stock_adjustment_backfill_log'
       AND cmd IN ('INSERT','UPDATE','DELETE')
  ),
  'backfill_log has SELECT policy only — writes restricted to SECURITY DEFINER RPC'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'list_adjustments_missing_journals'
       AND pg_get_function_arguments(oid) ILIKE '%p_offset%'
  ),
  'list_adjustments_missing_journals accepts a p_offset argument (Wave 5 pagination)'
);

-- ============== Wave 6 — persistent-drift cron alert ==============

SELECT has_table(
  'public', 'finance_alert_drift_streaks',
  'Wave 6: streak-tracking table for the drift cron alert exists'
);

SELECT has_column(
  'public', 'notification_alert_settings', 'finance_alert_missing_je_enabled',
  'Wave 6: per-business opt-out flag exists on notification_alert_settings'
);

SELECT has_function(
  'public', 'evaluate_missing_je_drift_alerts',
  ARRAY[]::text[],
  'Wave 6: evaluate_missing_je_drift_alerts() evaluator exists'
);

SELECT ok(
  (SELECT prosec FROM pg_proc WHERE proname = 'evaluate_missing_je_drift_alerts' LIMIT 1)
    IS TRUE,
  'Wave 6: drift evaluator is SECURITY DEFINER'
);

SELECT ok(
  (SELECT prosrc ILIKE '%consecutive_days >= v_alert_threshold%'
     OR   prosrc ILIKE '%v_streak >= v_alert_threshold%'
     OR   prosrc ILIKE '%>= 3%'
     FROM pg_proc WHERE proname = 'evaluate_missing_je_drift_alerts' LIMIT 1),
  'Wave 6: drift evaluator gates notifications on a multi-day streak'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'finance-missing-je-drift'
  ),
  'Wave 6: daily cron job finance-missing-je-drift is scheduled'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'finance_alert_drift_streaks'
       AND cmd        = 'SELECT'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'finance_alert_drift_streaks'
       AND cmd IN ('INSERT','UPDATE','DELETE')
  ),
  'Wave 6: drift-streaks table has SELECT policy only — writes via SECURITY DEFINER RPC'
);

SELECT * FROM finish();
ROLLBACK;
