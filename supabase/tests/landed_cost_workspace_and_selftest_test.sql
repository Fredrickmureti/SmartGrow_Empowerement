-- ============================================================================
-- Landed Cost — Phase C (retired self-test) and Phase E (server-side workspace)
--
-- Two ratchets:
--   * the in-database self-test harness stays dropped and stays out of the
--     single-writer registries;
--   * the workbench reads one server-side aggregate over every voucher, so no
--     competing landed-cost total can be reintroduced in the browser.
--
-- Read-only. Run inside a transaction and roll back.
-- ============================================================================
BEGIN;

-- 1. the parallel verification path stays retired ---------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname LIKE 'landed\_cost\_selftest%';
  IF n > 0 THEN
    RAISE EXCEPTION 'probe 1: % self-test function(s) are back in public; the SQL probe files are the verification path', n;
  END IF;

  IF EXISTS (SELECT 1 FROM public.inventory_valuation_writers WHERE function_name LIKE '%selftest%')
     OR EXISTS (SELECT 1 FROM public.stock_movement_writers   WHERE function_name LIKE '%selftest%') THEN
    RAISE EXCEPTION 'probe 1: a self-test harness is registered as a valuation/movement writer';
  END IF;
END $$;

-- 2. the single-writer registries are still complete without it ------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.check_valuation_writer_coverage();
  IF n > 0 THEN
    RAISE EXCEPTION 'probe 2: % valuation writer coverage issue(s) after retiring the harness', n;
  END IF;
END $$;

-- 3. the workspace summary is one server-side aggregate --------------------
DO $$
DECLARE
  n int;
  d text;
  vol boolean;
  sec boolean;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'landed_cost_workspace_summary';
  IF n <> 1 THEN
    RAISE EXCEPTION 'probe 3: landed_cost_workspace_summary must exist exactly once (found %)', n;
  END IF;

  SELECT pg_get_functiondef(p.oid), p.provolatile = 'v', p.prosecdef
    INTO d, vol, sec
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'landed_cost_workspace_summary';

  IF vol THEN
    RAISE EXCEPTION 'probe 3: the workspace summary is a read; it must not be VOLATILE';
  END IF;
  -- invoker rights: RLS on landed_cost_vouchers must scope the aggregate,
  -- exactly as it does for landed_cost_clearing_exposure.
  IF sec THEN
    RAISE EXCEPTION 'probe 3: the workspace summary must run with invoker rights so RLS applies';
  END IF;
  IF d NOT LIKE '%landed_cost_vouchers%' THEN
    RAISE EXCEPTION 'probe 3: the workspace summary must aggregate the canonical voucher table';
  END IF;
  IF d LIKE '%LIMIT%' THEN
    RAISE EXCEPTION 'probe 3: the workspace summary must cover every voucher, not a page';
  END IF;
  IF d LIKE '%INSERT%' OR d LIKE '%UPDATE %' OR d LIKE '%DELETE %' THEN
    RAISE EXCEPTION 'probe 3: the workspace summary is read-only';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.landed_cost_workspace_summary(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'probe 3: the app must be able to read the workspace summary';
  END IF;
END $$;

-- 4. lifecycle buckets are exhaustive and disjoint -------------------------
-- Every status a voucher can hold must land in exactly one workspace bucket,
-- otherwise vouchers vanish from the workbench.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(DISTINCT status::text, ', ') INTO missing
    FROM public.landed_cost_vouchers
   WHERE status::text NOT IN ('draft', 'pending_approval', 'allocated',
                              'posted', 'reversed', 'cancelled');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'probe 4: voucher status(es) % belong to no workspace bucket', missing;
  END IF;
END $$;

ROLLBACK;
