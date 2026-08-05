-- ADR-0114 — supplier-scoped identity: structural + policy parity test.
--
-- Runs against the live database. It asserts the *contract* of supplier
-- scoping — signatures, the two partitioned uniqueness indexes, and the
-- authenticated-only grants — without seeding tenant data, because the
-- resolver is gated by `user_can_access_business` and a DO block runs as
-- the migration role, which has no session user to gate on.
--
-- Behavioural vectors (cross-vendor reuse resolving only with vendor
-- context, `supplier_scoped` blocking without it) live in
-- `src/test/inventory/supplier-identity-scope.test.ts`.

DO $$
DECLARE
  v_args text;
BEGIN
  -- 1) One canonical resolver, five arguments, supplier last.
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_product_identity';
  IF v_args IS DISTINCT FROM
     'p_business_id uuid, p_code text, p_branch_id uuid, p_allow_sku_fallback boolean, p_supplier_id uuid' THEN
    RAISE EXCEPTION 'resolve_product_identity signature drifted: %', v_args;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'resolve_product_identity') <> 1 THEN
    RAISE EXCEPTION 'more than one resolve_product_identity overload exists';
  END IF;

  -- 2) The legacy resolvers and the legacy write RPC are gone for good.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('pos_resolve_barcode','resolve_barcode_v2','enroll_product_barcode')) THEN
    RAISE EXCEPTION 'a dropped legacy identity RPC has been reintroduced';
  END IF;

  -- 3) Both partitioned uniqueness indexes exist: a code may be reused
  --    across vendors, but never twice inside one scope.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'product_identifiers'
                    AND indexdef ILIKE '%supplier_id IS NULL%' AND indexdef ILIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'global (supplier-less) uniqueness index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'product_identifiers'
                    AND indexdef ILIKE '%supplier_id IS NOT NULL%' AND indexdef ILIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'supplier-scoped uniqueness index missing';
  END IF;

  -- 4) Uniqueness is partial on status so a retired code can be re-issued.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'product_identifiers'
                    AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%active%') THEN
    RAISE EXCEPTION 'uniqueness is not scoped to active identifiers';
  END IF;

  -- 5) Identity surface is authenticated-only: never anon, never PUBLIC.
  FOR v_args IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('resolve_product_identity','pos_resolve_scan',
                         'upsert_product_identifier','retire_product_identifier',
                         'discover_supplier_identity','identity_code_candidates',
                         'parse_gs1_element_string','gs1_ai_table')
  LOOP
    IF has_function_privilege('anon', ('public.' || v_args)::regproc, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute identity function %', v_args;
    END IF;
    IF NOT has_function_privilege('authenticated', ('public.' || v_args)::regproc, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute identity function %', v_args;
    END IF;
  END LOOP;

  -- 6) RLS still on the table itself.
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE relname = 'product_identifiers' AND relrowsecurity) THEN
    RAISE EXCEPTION 'RLS not enabled on product_identifiers';
  END IF;
END $$;
