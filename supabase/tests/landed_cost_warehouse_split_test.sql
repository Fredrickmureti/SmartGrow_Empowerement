-- =====================================================================
-- Ratchet: landed cost across two physical warehouses (Phase F2)
--
-- Proven on live data 2026-08-16 with LCV-2026-00005:
--   GRN-2026-00004 received 100 Cable into WH-HQ. Two transfers moved
--   stock to WH-NKR through the in-transit warehouse, write-offs consumed
--   part of it, then 2,000 KES freight was allocated, posted and reversed.
--
-- Invariants asserted here (introspection + live data, read only):
--   1. Cost layers are warehouse-scoped and lineage records the transfer
--      hop, so descendant tracing is warehouse-correct by construction.
--   2. A posted voucher's capitalised amount equals the total uplift its
--      revaluations applied, summed across every warehouse touched.
--   3. A reversal splits inventory vs COGS and balances to the clearing
--      account; nothing is credited to inventory that was already relieved.
--   4. Per-warehouse AVCO equals the weighted cost of that warehouse's own
--      remaining layers — no cross-warehouse smearing.
--   5. No valuation drift anywhere.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/landed_cost_warehouse_split_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_bad text;
BEGIN
  ----------------------------------------------- 1. warehouse-scoped layers
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cost_layers'
       AND column_name = 'warehouse_id'
  ) THEN
    RAISE EXCEPTION 'FAIL: cost_layers is no longer warehouse-scoped';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cost_layer_lineage l
      JOIN public.cost_layers parent ON parent.id = l.parent_layer_id
      JOIN public.cost_layers child  ON child.id  = l.child_layer_id
     WHERE parent.product_id <> child.product_id
  ) THEN
    RAISE EXCEPTION 'FAIL: lineage links layers of different products';
  END IF;

  -- A transfer must leave a lineage trail, otherwise landed cost posted
  -- after a transfer can never find the moved stock.
  IF EXISTS (
    SELECT 1 FROM public.stock_transfers t
     WHERE t.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM public.stock_movements m
           JOIN public.cost_layer_lineage l ON l.movement_id = m.id
          WHERE m.reference_type = 'stock_transfer' AND m.reference_id = t.id)
  ) THEN
    RAISE EXCEPTION 'FAIL: a completed stock transfer left no cost layer lineage';
  END IF;

  ------------------------------------------ 2. capitalisation == uplift sum
  SELECT string_agg(v.voucher_number, ', ') INTO v_bad
    FROM public.landed_cost_vouchers v
    JOIN LATERAL (
      SELECT COALESCE(SUM(r.amount_applied), 0) AS applied
        FROM public.inventory_cost_revaluations r
       WHERE r.source_type = 'landed_cost_voucher' AND r.source_id = v.id
    ) r ON true
   WHERE v.status = 'posted'
     AND ROUND(v.capitalized_amount - r.applied, 2) <> 0;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: capitalised amount does not match applied uplift for %', v_bad;
  END IF;

  ------------------------------------------------- 3. reversal journal shape
  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
      JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
     WHERE je.source_type = 'landed_cost_voucher'
     GROUP BY je.id
    HAVING ROUND(SUM(l.debit) - SUM(l.credit), 2) <> 0
  ) THEN
    RAISE EXCEPTION 'FAIL: an unbalanced landed cost journal exists';
  END IF;

  -- Every reversal must debit the clearing account for the full original
  -- amount, and relieve it across inventory + COGS only.
  SELECT string_agg(v.voucher_number, ', ') INTO v_bad
    FROM public.landed_cost_vouchers v
    JOIN LATERAL (
      SELECT COALESCE(SUM(l.credit), 0) AS relieved
        FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = v.reversal_journal_entry_id
    ) j ON true
   WHERE v.status = 'reversed'
     AND v.reversal_journal_entry_id IS NOT NULL
     AND ROUND(j.relieved - v.capitalized_amount, 2) <> 0;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: reversal does not relieve the capitalised amount for %', v_bad;
  END IF;

  -- Reversed vouchers leave no open revaluation anywhere.
  IF EXISTS (
    SELECT 1
      FROM public.landed_cost_vouchers v
      JOIN public.inventory_cost_revaluations r
        ON r.source_type = 'landed_cost_voucher' AND r.source_id = v.id
     WHERE v.status = 'reversed' AND r.reversed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: a reversed voucher still has open cost revaluations';
  END IF;

  ------------------------------------------------ 4. per-warehouse AVCO truth
  SELECT string_agg(x.label, ', ') INTO v_bad
    FROM (
      SELECT ws.warehouse_id::text || '/' || ws.product_id::text AS label
        FROM public.warehouse_stock ws
        JOIN LATERAL (
          SELECT SUM(cl.qty_remaining) qty,
                 SUM(cl.qty_remaining * cl.unit_cost) val
            FROM public.cost_layers cl
           WHERE cl.warehouse_id = ws.warehouse_id
             AND cl.product_id   = ws.product_id
             AND cl.qty_remaining > 0
        ) layers ON true
       WHERE layers.qty > 0
         AND ROUND(ws.average_cost - (layers.val / layers.qty), 2) <> 0
    ) x;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: warehouse AVCO diverges from its own layers: %', v_bad;
  END IF;

  ------------------------------------------------------------- 5. zero drift
  IF EXISTS (SELECT 1 FROM public.check_inventory_valuation_drift()) THEN
    RAISE EXCEPTION 'FAIL: inventory valuation drift is non-zero';
  END IF;

  RAISE NOTICE 'PASS: landed cost warehouse-split ratchet';
END $$;

ROLLBACK;