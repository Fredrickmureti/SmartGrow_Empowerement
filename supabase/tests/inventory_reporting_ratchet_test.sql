-- ============================================================================
-- Inventory reporting ratchet
-- ============================================================================
-- Locks in the Phase 1 + Phase 2 guarantees of the inventory reporting domain.
-- Every assertion below encodes a defect that was found and fixed; a failure
-- means a regression, not a flaky test.
--
-- Run: psql -f supabase/tests/inventory_reporting_ratchet_test.sql
-- ============================================================================
BEGIN;

DO $ratchet$
DECLARE
  v_missing text;
  v_count   int;
BEGIN
  -- ── 1. The reporting RPCs must exist and be SECURITY DEFINER with a
  --       pinned search_path (they read across business boundaries).
  FOR v_missing IN
    SELECT f
    FROM unnest(ARRAY[
      'report_stock_ledger',
      'report_inventory_valuation_as_of',
      '_assert_inventory_report_access',
      '_is_trusted_inventory_diag_context'
    ]) AS f
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = f
    )
  LOOP
    RAISE EXCEPTION 'RATCHET: required inventory reporting function is missing: %', v_missing;
  END LOOP;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('report_stock_ledger', 'report_inventory_valuation_as_of')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c
                        WHERE c ILIKE 'search_path=%'));
  IF v_count > 0 THEN
    RAISE EXCEPTION 'RATCHET: % reporting RPC(s) are not SECURITY DEFINER with a pinned search_path', v_count;
  END IF;

  -- ── 2. Anonymous callers must never reach inventory reporting or the
  --       inventory diagnostics. These read costs and quantities org-wide.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'report_stock_ledger',
      'report_inventory_valuation_as_of',
      'reconcile_inventory_subledger_to_gl',
      'check_inventory_valuation_drift',
      'check_valuation_writer_coverage',
      'check_movement_reversal_coverage'
    )
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'RATCHET: % inventory function(s) are still executable by anon', v_count;
  END IF;

  -- ── 3. Cost-layer RLS must be business-scoped, not merely org-scoped.
  --       Org-only scoping leaked one business's costs to a sibling business.
  FOR v_missing IN
    SELECT t
    FROM unnest(ARRAY['cost_layers', 'cost_layer_consumptions']) AS t
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND COALESCE(qual, '') || COALESCE(with_check, '') ILIKE '%business%'
    )
  LOOP
    RAISE EXCEPTION 'RATCHET: % has no business-scoped RLS policy', v_missing;
  END LOOP;

  -- ── 4. RLS must actually be enabled on the cost-layer tables.
  SELECT count(*) INTO v_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('cost_layers', 'cost_layer_consumptions')
    AND NOT c.relrowsecurity;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'RATCHET: RLS is disabled on % cost-layer table(s)', v_count;
  END IF;

  -- ── 5. Reporting RPCs must reject a NULL business for Data API callers:
  --       p_business is an authorization boundary, never an optional filter.
  --       (Checked as source text because the guard cannot run as superuser.)
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('report_stock_ledger', 'report_inventory_valuation_as_of')
    AND p.prosrc NOT LIKE '%_assert_inventory_report_access%';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'RATCHET: % reporting RPC(s) skip the business/branch access assertion', v_count;
  END IF;

  -- ── 6. Valuation must be reconstructed from cost layers, never from the
  --       live qty_remaining / current AVCO (that made every historical
  --       "as of" figure silently wrong).
  IF (SELECT p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'report_inventory_valuation_as_of')
     NOT LIKE '%cost_layer_consumptions%'
  THEN
    RAISE EXCEPTION 'RATCHET: valuation RPC no longer replays cost_layer_consumptions as at the reporting date';
  END IF;

  RAISE NOTICE 'RATCHET PASS: inventory reporting security and valuation invariants hold';
END
$ratchet$;

-- ── 7. Behavioural tie-out: for any product/warehouse the quantity ledger's
--       closing quantity must equal the value ledger's quantity on hand at the
--       same date. A break here means the two ledgers have diverged.
DO $tieout$
DECLARE
  v_org      uuid;
  v_business uuid;
  v_breaks   int;
BEGIN
  SELECT organization_id, business_id INTO v_org, v_business
  FROM public.stock_movements
  WHERE business_id IS NOT NULL
  GROUP BY organization_id, business_id
  ORDER BY count(*) DESC
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no stock movements to tie out';
    RETURN;
  END IF;

  SELECT count(*) INTO v_breaks
  FROM public.report_stock_ledger(
         v_org, v_business, '1900-01-01'::date, current_date, NULL, NULL, NULL, NULL, 5000, 0) l
  FULL JOIN public.report_inventory_valuation_as_of(
         v_org, v_business, current_date, NULL, NULL, NULL, NULL, 5000, 0) v
    ON v.product_id = l.product_id
   AND v.warehouse_id IS NOT DISTINCT FROM l.warehouse_id
  WHERE abs(COALESCE(l.closing_qty, 0) - COALESCE(v.qty_on_hand, 0)) > 0.0001;

  IF v_breaks > 0 THEN
    RAISE WARNING 'TIE-OUT: % product/warehouse line(s) where ledger closing qty <> valuation qty on hand', v_breaks;
  ELSE
    RAISE NOTICE 'TIE-OUT PASS: quantity ledger agrees with value ledger';
  END IF;
END
$tieout$;

-- ── 8. Phase 6 tie-out: for the same business and date the reconciliation's
--       subledger total MUST equal the Inventory Valuation total. Before the
--       re-base the reconciliation valued stock at live AVCO while the
--       valuation report replayed cost layers, so "drift" against the GL was
--       not attributable to the ledger. This assertion is the contract.
DO $recon$
DECLARE
  v_org        uuid;
  v_business   uuid;
  v_subledger  numeric;
  v_valuation  numeric;
  v_aging      numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_inventory_layer_valuation_as_of'
  ) THEN
    RAISE EXCEPTION 'RATCHET: shared layer valuation helper _inventory_layer_valuation_as_of is missing';
  END IF;

  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reconcile_inventory_subledger_to_gl')
     NOT LIKE '%_inventory_layer_valuation_as_of%'
  THEN
    RAISE EXCEPTION 'RATCHET: reconciliation no longer values the subledger from the shared cost-layer helper';
  END IF;

  SELECT organization_id, business_id INTO v_org, v_business
  FROM public.stock_movements
  WHERE business_id IS NOT NULL
  GROUP BY organization_id, business_id
  ORDER BY count(*) DESC
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no stock movements to reconcile';
    RETURN;
  END IF;

  SELECT COALESCE(sum(subledger_value), 0) INTO v_subledger
  FROM public.reconcile_inventory_subledger_to_gl(v_org, v_business, current_date);

  SELECT COALESCE(sum(total_value), 0) INTO v_valuation
  FROM public.report_inventory_valuation_as_of(
         v_org, v_business, current_date, NULL, NULL, NULL, NULL, 100000, 0);

  IF abs(v_subledger - v_valuation) > 0.01 THEN
    RAISE EXCEPTION 'TIE-OUT FAIL: reconciliation subledger % <> valuation total % for the same date',
      v_subledger, v_valuation;
  END IF;

  -- Aging buckets partition the same valuation, so they must sum to it too.
  SELECT COALESCE(sum(COALESCE(value_0_30, 0) + COALESCE(value_31_60, 0)
                    + COALESCE(value_61_90, 0) + COALESCE(value_90_plus, 0)), 0)
    INTO v_aging
  FROM public.report_inventory_aging_as_of(
         v_org, v_business, current_date, NULL, NULL, NULL, NULL, 100000, 0);

  IF abs(v_aging - v_valuation) > 0.01 THEN
    RAISE WARNING 'TIE-OUT: aging buckets % <> valuation total %', v_aging, v_valuation;
  ELSE
    RAISE NOTICE 'TIE-OUT PASS: reconciliation, valuation and aging agree';
  END IF;
END
$recon$;

-- ── 9. Cross-business denial: the re-based reconciliation must refuse a
--       business that does not belong to the caller's organization.
DO $deny$
DECLARE
  v_org      uuid;
  v_foreign  uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses LIMIT 1;
  SELECT id INTO v_foreign FROM public.businesses
   WHERE organization_id IS DISTINCT FROM v_org LIMIT 1;

  IF v_org IS NULL OR v_foreign IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: need two organizations to assert cross-business denial';
    RETURN;
  END IF;

  BEGIN
    PERFORM * FROM public.reconcile_inventory_subledger_to_gl(v_org, v_foreign, current_date);
    RAISE EXCEPTION 'RATCHET: reconciliation returned rows for a business outside the organization';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'RATCHET:%' THEN RAISE; END IF;
    RAISE NOTICE 'DENIAL PASS: cross-business reconciliation rejected (%)', SQLERRM;
  END;
END
$deny$;

-- ── 10. Phase 6b: the subledger composition must be built from the SAME
--        authoritative layer valuation as the reconciliation total, so its
--        value column sums to subledger_value at the same date.
DO $comp$
DECLARE
  v_org        uuid;
  v_business   uuid;
  v_subledger  numeric;
  v_composed   numeric;
BEGIN
  SELECT organization_id, id INTO v_org, v_business
  FROM public.businesses
  WHERE id IN (SELECT DISTINCT business_id FROM public.cost_layers WHERE business_id IS NOT NULL)
  LIMIT 1;

  IF v_org IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no cost layers to compose';
    RETURN;
  END IF;

  SELECT COALESCE(sum(subledger_value), 0) INTO v_subledger
  FROM public.reconcile_inventory_subledger_to_gl(v_org, v_business, current_date);

  SELECT COALESCE(sum(value), 0) INTO v_composed
  FROM public.list_inventory_subledger_composition(v_org, v_business, current_date, 5000);

  IF abs(v_subledger - v_composed) > 0.01 THEN
    RAISE EXCEPTION 'COMPOSITION FAIL: composition total % <> subledger value %',
      v_composed, v_subledger;
  END IF;
  RAISE NOTICE 'COMPOSITION PASS: composition explains the subledger figure exactly';

  -- Composition rows may only carry layer-derived bases.
  IF EXISTS (
    SELECT 1 FROM public.list_inventory_subledger_composition(v_org, v_business, current_date, 5000)
     WHERE cost_basis NOT IN ('cost_layer','zero_cost_layer','negative_layer','unlayered')
  ) THEN
    RAISE EXCEPTION 'COMPOSITION FAIL: an AVCO / product-cost basis survives in the composition';
  END IF;
END
$comp$;

-- ── 11. Phase 6b: company scope is an authorization boundary on the
--        integrity helpers, not an optional filter.
DO $scope$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no businesses';
    RETURN;
  END IF;

  BEGIN
    PERFORM * FROM public.list_inventory_subledger_composition(v_org, NULL, current_date, 10);
    RAISE EXCEPTION 'RATCHET: composition accepted a null company';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'RATCHET:%' THEN RAISE; END IF;
    RAISE NOTICE 'SCOPE PASS: composition requires a company (%)', SQLERRM;
  END;

  BEGIN
    PERFORM * FROM public.list_negative_stock_positions(v_org, NULL);
    RAISE EXCEPTION 'RATCHET: negative-stock listing accepted a null company';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'RATCHET:%' THEN RAISE; END IF;
    RAISE NOTICE 'SCOPE PASS: negative-stock listing requires a company (%)', SQLERRM;
  END;
END
$scope$;

-- ── 12. Phase 7: lot traceability ties to Inventory Valuation at the same
--        date. Depleted lots are hidden by default precisely so that the sum
--        of lot value equals valuation value for lot-tracked products.
DO $lot$
DECLARE
  v_org       uuid;
  v_business  uuid;
  v_lot_value numeric;
  v_val_value numeric;
BEGIN
  SELECT organization_id, id INTO v_org, v_business FROM public.businesses LIMIT 1;
  IF v_business IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no businesses';
    RETURN;
  END IF;

  SELECT COALESCE(sum(total_value), 0) INTO v_lot_value
  FROM public.report_lot_traceability_as_of(
    v_org, v_business, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 100000, 0);

  SELECT COALESCE(sum(v.total_value), 0) INTO v_val_value
  FROM public.report_inventory_valuation_as_of(
    v_org, v_business, current_date, NULL, NULL, NULL, NULL, 100000, 0) v
  WHERE v.product_id IN (
    SELECT DISTINCT product_id
    FROM public.report_lot_traceability_as_of(
      v_org, v_business, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 100000, 0)
  );

  IF abs(v_lot_value - v_val_value) > 0.01 THEN
    RAISE EXCEPTION 'LOT FAIL: lot value % <> valuation value % for lot-tracked products',
      v_lot_value, v_val_value;
  END IF;
  RAISE NOTICE 'LOT PASS: lot value ties to valuation at the same date';

  -- Default must exclude depleted lots; including them may only add rows.
  IF (
    SELECT count(*) FROM public.report_lot_traceability_as_of(
      v_org, v_business, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, 100000, 0)
  ) < (
    SELECT count(*) FROM public.report_lot_traceability_as_of(
      v_org, v_business, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 100000, 0)
  ) THEN
    RAISE EXCEPTION 'LOT FAIL: include_depleted returned fewer rows than the default';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.report_lot_traceability_as_of(
      v_org, v_business, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 100000, 0)
     WHERE qty_on_hand = 0
  ) THEN
    RAISE EXCEPTION 'LOT FAIL: a depleted lot leaked into the default result';
  END IF;
  RAISE NOTICE 'LOT PASS: depleted lots excluded by default';
END
$lot$;

-- ── 13. Phase 7: company scope is an authorization boundary on the lot
--        report, and a cross-company pairing must be refused.
DO $lotscope$
DECLARE
  v_org      uuid;
  v_business uuid;
  v_other    uuid;
BEGIN
  SELECT organization_id, id INTO v_org, v_business FROM public.businesses LIMIT 1;
  IF v_business IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no businesses';
    RETURN;
  END IF;

  BEGIN
    PERFORM * FROM public.report_lot_traceability_as_of(
      v_org, NULL, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 10, 0);
    RAISE EXCEPTION 'RATCHET: lot report accepted a null company';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'RATCHET:%' THEN RAISE; END IF;
    RAISE NOTICE 'LOT SCOPE PASS: lot report requires a company (%)', SQLERRM;
  END;

  SELECT id INTO v_other
  FROM public.businesses
  WHERE organization_id IS DISTINCT FROM v_org
  LIMIT 1;

  IF v_other IS NULL THEN
    RAISE NOTICE 'RATCHET SKIP: no second organization to test cross-company denial';
    RETURN;
  END IF;

  BEGIN
    PERFORM * FROM public.report_lot_traceability_as_of(
      v_org, v_other, current_date, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 10, 0);
    RAISE EXCEPTION 'RATCHET: lot report served a company outside the organization';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'RATCHET:%' THEN RAISE; END IF;
    RAISE NOTICE 'LOT SCOPE PASS: cross-company lot read denied (%)', SQLERRM;
  END;
END
$lotscope$;

ROLLBACK;
