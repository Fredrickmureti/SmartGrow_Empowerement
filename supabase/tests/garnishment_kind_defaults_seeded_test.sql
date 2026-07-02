-- Verifies the phase-2 garnishment defaults are present and correctly shaped.
-- The engine relies on these rows to (a) order child-support first and
-- (b) exclude child-support from the aggregate cap pool.

BEGIN;

DO $$
DECLARE
  v_cs record;
  v_count int;
BEGIN
  SELECT * INTO v_cs FROM public.garnishment_kind_defaults WHERE kind = 'child_support';
  IF v_cs IS NULL THEN RAISE EXCEPTION 'child_support default missing'; END IF;
  IF NOT v_cs.always_first THEN RAISE EXCEPTION 'child_support must be always_first'; END IF;
  IF v_cs.counts_toward_aggregate_cap THEN RAISE EXCEPTION 'child_support must be cap-exempt'; END IF;

  SELECT count(*) INTO v_count FROM public.garnishment_kind_defaults;
  IF v_count < 7 THEN RAISE EXCEPTION 'expected >= 7 kind defaults, got %', v_count; END IF;

  -- Aggregate-cap-counted kinds must not be always_first (engine sort assumption)
  PERFORM 1 FROM public.garnishment_kind_defaults
    WHERE counts_toward_aggregate_cap = true AND always_first = true;
  IF FOUND THEN
    RAISE EXCEPTION 'no kind should be both always_first and counted toward aggregate cap';
  END IF;
END $$;

-- New columns + status enum exist
DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'garnishment_status';
  IF NOT FOUND THEN RAISE EXCEPTION 'garnishment_status enum missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employee_garnishments' AND column_name='aggregate_cap_exempt';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee_garnishments.aggregate_cap_exempt missing'; END IF;

  PERFORM 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payroll_settings' AND column_name='garnishment_aggregate_cap_pct';
  IF NOT FOUND THEN RAISE EXCEPTION 'payroll_settings.garnishment_aggregate_cap_pct missing'; END IF;
END $$;

-- Ledger view exists and is readable
SELECT count(*) FROM public.garnishment_ledger;

ROLLBACK;
