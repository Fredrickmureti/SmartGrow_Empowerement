-- Phase 5D guards: posted landed-cost history cannot change meaning.
--
-- Invariants proven here:
--   1. landed_cost_allocations carries the measurement snapshot columns
--      (basis_packaging_id, basis_qty, basis_per_unit, basis_uom_id,
--      basis_snapshot_at) — the allocation basis is history, not a re-derivation
--      of today's product master.
--   2. landed_cost_allocate_voucher writes that snapshot on every line.
--   3. Allocation lines of a POSTED voucher cannot be deleted.
--   4. Allocation lines of a POSTED voucher cannot have their basis or amount
--      rewritten — the only remedy is a reversal.
--   5. Non-posted vouchers are still freely re-allocatable (the guard is scoped
--      to posted history, not to drafts).
--   6. The physical-attribute purchasing policy exists as configuration
--      (businesses.require_product_physical_attributes +
--      product_physical_attributes_required resolver + receipt trigger), so an
--      unmeasured product fails at receipt time rather than at allocation time.
--   7. Live data: every allocation created after this migration on a weight or
--      volume basis carries a basis unit, so no snapshot is unit-less.
--
-- Everything mutating runs inside a transaction that is rolled back.

BEGIN;

-- 1. Snapshot columns exist.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['basis_packaging_id','basis_qty','basis_per_unit',
                      'basis_uom_id','basis_snapshot_at']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'landed_cost_allocations'
        AND column_name = c);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'landed_cost_allocations is missing basis snapshot columns: %', v_missing;
  END IF;
END $$;

-- 2. The allocator writes the snapshot.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'landed_cost_allocate_voucher is missing';
  END IF;

  IF v_def !~ 'basis_per_unit' OR v_def !~ 'basis_uom_id'
     OR v_def !~ 'basis_snapshot_at' OR v_def !~ 'basis_qty' THEN
    RAISE EXCEPTION 'landed_cost_allocate_voucher no longer snapshots the allocation basis';
  END IF;
END $$;

-- 3/4/5. The immutability trigger.
DO $$
DECLARE
  v_alloc RECORD;
  v_raised boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_landed_cost_allocation_immutable'
       AND tgrelid = 'public.landed_cost_allocations'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'posted allocation lines are not protected by an immutability trigger';
  END IF;

  SELECT a.* INTO v_alloc
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_vouchers v ON v.id = a.voucher_id
   WHERE v.status = 'posted'
   LIMIT 1;

  IF v_alloc.id IS NULL THEN
    RAISE NOTICE 'landed_cost_basis_immutability_test: no posted allocation on file — behavioural probes skipped';
  ELSE
    -- 4. Basis rewrite is refused.
    v_raised := false;
    BEGIN
      UPDATE public.landed_cost_allocations
         SET basis_value = COALESCE(basis_value, 0) + 1
       WHERE id = v_alloc.id;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'LANDED_COST_ALLOCATION_IMMUTABLE%' THEN v_raised := true; ELSE RAISE; END IF;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'a posted allocation basis was rewritten';
    END IF;

    -- 3. Deletion is refused.
    v_raised := false;
    BEGIN
      DELETE FROM public.landed_cost_allocations WHERE id = v_alloc.id;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'LANDED_COST_ALLOCATION_IMMUTABLE%' THEN v_raised := true; ELSE RAISE; END IF;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'a posted allocation line was deleted';
    END IF;
  END IF;

  -- 5. Draft/allocated vouchers stay mutable.
  SELECT a.* INTO v_alloc
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_vouchers v ON v.id = a.voucher_id
   WHERE v.status IN ('draft', 'allocated', 'pending_approval')
   LIMIT 1;

  IF v_alloc.id IS NOT NULL THEN
    UPDATE public.landed_cost_allocations
       SET basis_value = COALESCE(basis_value, 0)
     WHERE id = v_alloc.id;
  END IF;
END $$;

-- 6. The physical-attribute requirement is configuration, not a hard rule.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'businesses'
       AND column_name = 'require_product_physical_attributes'
       AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'businesses.require_product_physical_attributes is missing or has no default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'product_physical_attributes_required'
  ) THEN
    RAISE EXCEPTION 'the physical-attribute policy resolver is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_receipt_product_physical_attributes'
       AND tgrelid = 'public.goods_receipt_items'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the receipt-time physical-attribute policy is not enforced';
  END IF;
END $$;

-- 7. Live data: no unit-less physical snapshot.
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.landed_cost_allocations
   WHERE basis::text IN ('weight', 'volume')
     AND basis_snapshot_at IS NOT NULL
     AND basis_uom_id IS NULL;

  IF v_bad > 0 THEN
    RAISE EXCEPTION '% physical allocation snapshots carry no unit of measure', v_bad;
  END IF;
END $$;

ROLLBACK;
