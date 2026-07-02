-- POS scanner kernel — SQL structural tests for product_identifiers,
-- pos_barcode_rules, and the pos_resolve_barcode RPC.
--
-- Full end-to-end seeded tests live alongside the vitest suite; this file
-- runs against the live DB and asserts shape, signature, and basic
-- isolation guarantees.

-- 1) Tables exist with RLS enabled.
DO $$
BEGIN
  PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'product_identifiers' AND n.nspname = 'public';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_identifiers table missing';
  END IF;
  PERFORM 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'pos_barcode_rules' AND n.nspname = 'public';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_barcode_rules table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'product_identifiers' AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on product_identifiers';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'pos_barcode_rules' AND relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on pos_barcode_rules';
  END IF;
END $$;

-- 2) Unique business+code (case-insensitive) index exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'product_identifiers_business_code_uidx'
  ) THEN
    RAISE EXCEPTION 'product_identifiers unique business+code index missing';
  END IF;
END $$;

-- 3) RPC signature is what callers expect.
DO $$
DECLARE
  v_args text;
BEGIN
  SELECT pg_get_function_identity_arguments('public.pos_resolve_barcode'::regproc) INTO v_args;
  IF v_args <> 'p_business_id uuid, p_branch_id uuid, p_code text' THEN
    RAISE EXCEPTION 'pos_resolve_barcode signature drift: %', v_args;
  END IF;
END $$;

-- 4) Unknown code returns zero rows (no exception, no leak).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.pos_resolve_barcode(
    '00000000-0000-0000-0000-000000000000'::uuid,
    NULL,
    '__nonexistent_code_12345__'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'expected 0 rows for unknown code, got %', v_count;
  END IF;
END $$;

-- 5) Empty / null code also returns zero rows without raising.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.pos_resolve_barcode(
    '00000000-0000-0000-0000-000000000000'::uuid,
    NULL,
    ''
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'expected 0 rows for empty code, got %', v_count;
  END IF;
END $$;

-- 6) Sync trigger is attached to products.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_sync_product_identifiers'
      AND tgrelid = 'public.products'::regclass
  ) THEN
    RAISE EXCEPTION 'trg_sync_product_identifiers missing on products';
  END IF;
END $$;

-- 7) Type-mismatch regression guard (2026-05-18).
--
-- The function previously declared `etims_tax_code text` in RETURNS TABLE
-- but pulled it from `tax_rates.etims_tax_code varchar(1)`. PostgreSQL
-- raises 42804 on every call, which the POS client surfaced to cashiers as
-- "invalid barcode" — breaking EVERY scan, not just an unlucky one.
--
-- This test issues a real call against a non-existent business+code pair.
-- A failed CAST inside RETURN QUERY would surface as a 42804 error rather
-- than an empty result set.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.pos_resolve_barcode(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'regression-probe-1234567890'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'expected 0 rows for probe code, got %', v_count;
  END IF;
END $$;
