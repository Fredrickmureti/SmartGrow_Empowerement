-- =====================================================================
-- Ratchet: physical (weight / volume) landed cost allocation
-- (Phase F — 2026-08-16)
--
-- Weight and volume bases were implemented but had never been exercised:
-- product_physical_attributes was empty, so every physical allocation
-- refused. This file locks in the behaviour now that real measures exist.
--
-- Invariants:
--   1. resolve_product_measure is the single measure reader, and allocation
--      refuses (never fabricates) when a measure is missing.
--   2. The measure is taken at the level the line was RECEIVED in: per
--      package x number of packages when the receipt line carries packaging.
--   3. Physical bases are snapshotted on the allocation row
--      (basis_qty, basis_per_unit, basis_value, basis_uom_id) so a later
--      change to product master data cannot restate a posted allocation.
--   4. Weight and volume allocations sum back to the component amount
--      (rounding drift is absorbed, never dropped).
--   5. Physical measures themselves stay internally consistent: gross is
--      derived from net + tare, and a measure never exists without its unit.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/landed_cost_weight_volume_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  v_src text;
  v_bad text;
BEGIN
  ------------------------------------------------------------ one measure reader
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'resolve_product_measure') <> 1 THEN
    RAISE EXCEPTION 'FAIL: resolve_product_measure must exist exactly once';
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher';

  IF position('resolve_product_measure' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: allocation no longer reads measures through resolve_product_measure';
  END IF;
  IF position('no weight recorded' IN v_src) = 0
     OR position('no volume recorded' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: allocation no longer refuses by name when a physical measure is missing';
  END IF;
  IF position('display_quantity' IN v_src) = 0 OR position('packaging_id' IN v_src) = 0 THEN
    RAISE EXCEPTION 'FAIL: allocation no longer measures at the packaging level the line was received in';
  END IF;

  ----------------------------------------------------- measures are self-consistent
  IF EXISTS (
    SELECT 1 FROM public.product_physical_attributes
     WHERE (net_weight   IS NULL) <> (net_weight_uom_id   IS NULL)
        OR (tare_weight  IS NULL) <> (tare_weight_uom_id  IS NULL)
        OR (gross_weight IS NULL) <> (gross_weight_uom_id IS NULL)
        OR (volume       IS NULL) <> (volume_uom_id       IS NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL: a physical measure exists without its unit of measure';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.product_physical_attributes
     WHERE net_weight IS NOT NULL
       AND abs(
             public.convert_uom(gross_weight, gross_weight_uom_id, net_weight_uom_id)
             - (net_weight + COALESCE(public.convert_uom(tare_weight, tare_weight_uom_id, net_weight_uom_id), 0))
           ) > GREATEST(net_weight * 0.005, 0.0001)
  ) THEN
    RAISE EXCEPTION 'FAIL: gross weight no longer equals net weight plus packaging weight';
  END IF;

  -- convert_uom must treat "no quantity" as no conversion, not as a bad unit;
  -- otherwise capturing a net weight with no tare weight fails.
  IF public.convert_uom(NULL, NULL, (SELECT id FROM public.units_of_measure LIMIT 1)) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: convert_uom(NULL, ...) must return NULL';
  END IF;

  --------------------------------------------------------- basis snapshot is stored
  IF EXISTS (
    SELECT 1 FROM public.landed_cost_allocations
     WHERE basis IN ('weight', 'volume')
       AND (basis_qty IS NULL OR basis_per_unit IS NULL
            OR basis_uom_id IS NULL OR basis_snapshot_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL: a physical allocation was written without its measure snapshot';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.landed_cost_allocations
     WHERE basis IN ('weight', 'volume')
       AND ROUND(basis_value, 6) <> ROUND(basis_qty * basis_per_unit, 6)
  ) THEN
    RAISE EXCEPTION 'FAIL: a physical basis value does not equal quantity x measure per unit';
  END IF;

  ------------------------------------------------------------- allocation is exact
  SELECT string_agg(x.voucher_id::text, ', ') INTO v_bad
    FROM (
      SELECT a.voucher_id, a.component_id,
             SUM(a.allocated_amount) AS allocated,
             MAX(c.base_amount)      AS component
        FROM public.landed_cost_allocations a
        JOIN public.landed_cost_components c ON c.id = a.component_id
       WHERE a.basis IN ('weight', 'volume')
       GROUP BY a.voucher_id, a.component_id
      HAVING ROUND(SUM(a.allocated_amount), 2) <> ROUND(MAX(c.base_amount), 2)
    ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: physical allocation does not sum back to the component amount (voucher %)', v_bad;
  END IF;

  -- No allocation may carry a non-positive physical basis: that would mean a
  -- measure was silently defaulted instead of refused.
  IF EXISTS (
    SELECT 1 FROM public.landed_cost_allocations
     WHERE basis IN ('weight', 'volume') AND COALESCE(basis_value, 0) <= 0
  ) THEN
    RAISE EXCEPTION 'FAIL: a physical allocation was written with a zero or missing basis';
  END IF;

  RAISE NOTICE 'PASS: landed cost weight/volume allocation ratchet';
END $$;

ROLLBACK;
