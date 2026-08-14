-- ADR 0142 — one availability engine (Phase 7e ratchet).
--
-- Fails if:
--   1. `resolve_stock_availability_batch` disappears or gains a second overload;
--   2. `resolve_stock_availability` stops being a thin wrapper over it;
--   3. any other `public` function derives availability with
--      `quantity - reserved_quantity` arithmetic instead of calling the engine.
--
-- SQL comments are stripped before matching, so documentation that *mentions*
-- the forbidden formula does not trip the guard.
--
-- ALLOWLIST — this list may only ever SHRINK:
--   `_wms_maybe_enqueue_replen`  Warehouse-owned pick-face replenishment. It
--     derives availability at BIN (location) grain from `stock_quants`, a grain
--     the canonical engine does not yet expose (it scopes to business / branch /
--     warehouse). `stock_quants.reserved_quantity` is itself a guarded
--     projection of `stock_reservations` (`trg_guard_quant_reserved`), so the
--     number is still engine-derived. Follow-up: add a location grain to
--     `resolve_stock_availability_batch` and delete this exemption.

BEGIN;

DO $$
DECLARE
  v_count integer;
  v_offender text;
  v_allowed text[] := ARRAY['_wms_maybe_enqueue_replen'];
BEGIN
  -- 1. the engine exists, exactly once
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_stock_availability_batch';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'ADR0142: expected exactly 1 resolve_stock_availability_batch, found %', v_count;
  END IF;

  -- 2. it is SECURITY DEFINER with a business-access check, and not anon-callable
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'resolve_stock_availability_batch'
       AND p.prosecdef
       AND p.prosrc ILIKE '%user_has_business_access%'
  ) THEN
    RAISE EXCEPTION
      'ADR0142: resolve_stock_availability_batch must be SECURITY DEFINER with a business-access check';
  END IF;

  IF has_function_privilege('anon',
       (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'resolve_stock_availability_batch'),
       'EXECUTE') THEN
    RAISE EXCEPTION 'ADR0142: resolve_stock_availability_batch must not be executable by anon';
  END IF;

  -- 3. the single-product function is a wrapper, not a second formula
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_stock_availability';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'ADR0142: expected exactly 1 resolve_stock_availability overload, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'resolve_stock_availability'
       AND p.prosrc ILIKE '%resolve_stock_availability_batch%'
  ) THEN
    RAISE EXCEPTION
      'ADR0142: resolve_stock_availability must delegate to resolve_stock_availability_batch';
  END IF;

  -- 4. nobody else recomputes availability
  SELECT string_agg(s.proname, ', ' ORDER BY s.proname) INTO v_offender
  FROM (
    SELECT p.proname,
           regexp_replace(
             regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
             '\s+', ' ', 'g') AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proname <> ALL (v_allowed)
       AND p.proname NOT IN (
         'resolve_stock_availability_batch',
         'resolve_stock_availability'
       )
  ) s
  WHERE s.body ~* '(quantity|on_hand)\s*-\s*(COALESCE\s*\(\s*)?reserved';

  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'ADR0142: second availability formula found in: %. Call resolve_stock_availability_batch instead.',
      v_offender;
  END IF;

  RAISE NOTICE 'ADR0142 availability single-formula ratchet: OK';
END $$;

ROLLBACK;
