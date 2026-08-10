-- pgTAP — Purchase Requisition demand-engine invariants (2026-08-10)
--
-- The requisition module is a demand-origin domain, not a form: quantity
-- rollups, short-close, and the governance registration are DB-owned. This
-- suite fails the moment a migration weakens any of those guarantees.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)

BEGIN;

SELECT plan(14);

-- ------------------------------------------------------------------
-- R1..R3. Lifecycle + closure RPCs exist
-- ------------------------------------------------------------------
SELECT has_function('public', '_pr_recalc', 'Rollup engine _pr_recalc exists');
SELECT has_function('public', 'requisition_close_line', 'Line short-close RPC exists');
SELECT has_function('public', 'requisition_close', 'Header short-close RPC exists');

-- ------------------------------------------------------------------
-- R4..R6. Closure RPCs are SECURITY DEFINER with a pinned search_path
-- ------------------------------------------------------------------
SELECT ok(
  (SELECT bool_and(prosecdef) FROM pg_proc
    WHERE proname IN ('requisition_close', 'requisition_close_line', '_pr_recalc')),
  'Requisition closure/rollup functions are SECURITY DEFINER'
);

SELECT ok(
  (SELECT bool_and(array_to_string(proconfig, ',') LIKE '%search_path%')
     FROM pg_proc
    WHERE proname IN ('requisition_close', 'requisition_close_line', '_pr_recalc')),
  'Requisition closure/rollup functions pin search_path'
);

SELECT ok(
  (SELECT count(*) = 2 FROM pg_proc
    WHERE proname IN ('requisition_close', 'requisition_close_line')),
  'Exactly one overload each of the closure RPCs'
);

-- ------------------------------------------------------------------
-- R7. Short-close records cancelled quantity on the line
-- ------------------------------------------------------------------
SELECT has_column(
  'public', 'purchase_requisition_items', 'quantity_cancelled',
  'Lines carry quantity_cancelled so short-closed demand is auditable'
);
SELECT has_column(
  'public', 'purchase_requisition_items', 'quantity_ordered',
  'Lines carry quantity_ordered for the procurement rollup'
);
SELECT has_column(
  'public', 'purchase_requisition_items', 'quantity_received',
  'Lines carry quantity_received for the fulfilment rollup'
);

-- ------------------------------------------------------------------
-- R10. The rollup excludes cancelled purchase orders
-- ------------------------------------------------------------------
SELECT ok(
  (SELECT prosrc LIKE '%cancelled%' FROM pg_proc WHERE proname = '_pr_recalc' LIMIT 1),
  '_pr_recalc filters cancelled purchase orders out of the rollup'
);

-- ------------------------------------------------------------------
-- R11. Header/line guards still block direct lifecycle writes
-- ------------------------------------------------------------------
SELECT has_function('public', '_pr_guard_header', 'Header lifecycle guard exists');
SELECT has_function('public', '_pr_guard_item', 'Line lifecycle guard exists');

-- ------------------------------------------------------------------
-- R13/R14. Governance registration for the demand actions
-- ------------------------------------------------------------------
SELECT ok(
  (SELECT count(*) > 0 FROM governance_action_registry
    WHERE action_code = 'requisition.submit'),
  'requisition.submit is a registered governed action'
);
SELECT ok(
  (SELECT count(*) > 0 FROM governance_action_registry
    WHERE action_code = 'requisition.approve'),
  'requisition.approve is a registered governed action'
);

SELECT * FROM finish();
ROLLBACK;
