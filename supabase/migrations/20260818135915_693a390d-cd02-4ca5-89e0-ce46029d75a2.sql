-- ─────────────────────────────────────────────────────────────────────────
-- Phase 14 / 15 — one representation of feed state; orphan removal.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) Feed state belongs to the connection + its runs, not to the account.
ALTER TABLE public.bank_accounts
  DROP COLUMN IF EXISTS sync_status,
  DROP COLUMN IF EXISTS sync_error,
  DROP COLUMN IF EXISTS last_sync_at;

-- 2) Read model for the UI: connection health + latest run, per bank account.
--    SECURITY INVOKER: RLS on the underlying tables decides visibility.
CREATE OR REPLACE FUNCTION public.bank_feed_status(_business_id uuid)
RETURNS TABLE (
  bank_account_id uuid,
  connection_id uuid,
  provider_code text,
  status text,
  auto_sync_enabled boolean,
  sync_frequency text,
  last_success_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer,
  last_run_id uuid,
  last_run_status text,
  last_run_started_at timestamptz,
  last_run_finished_at timestamptz,
  last_run_window_from date,
  last_run_window_to date,
  last_run_fetched integer,
  last_run_inserted integer,
  last_run_duplicates integer,
  last_run_rejected integer,
  last_run_error_code text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.bank_account_id,
    c.id,
    c.provider_code,
    c.status,
    c.auto_sync_enabled,
    c.sync_frequency,
    c.last_success_at,
    c.last_run_at,
    c.last_error,
    c.consecutive_failures,
    r.id,
    r.status,
    r.started_at,
    r.finished_at,
    r.window_from,
    r.window_to,
    r.fetched_count,
    r.inserted_count,
    r.duplicate_count,
    r.rejected_count,
    r.error_code
  FROM public.bank_feed_connections c
  LEFT JOIN LATERAL (
    SELECT *
    FROM public.bank_feed_runs br
    WHERE br.connection_id = c.id
    ORDER BY br.started_at DESC
    LIMIT 1
  ) r ON true
  WHERE c.business_id = _business_id;
$$;

REVOKE ALL ON FUNCTION public.bank_feed_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_feed_status(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bank_feed_status(uuid) TO authenticated, service_role;

-- 3) Orphan removal. A split bank line has exactly one representation:
--    allocations on the matching seam. And bank reconciliation has exactly one
--    session table: public.bank_reconciliation_sessions.
DROP TABLE IF EXISTS public.bank_transaction_splits;

-- Stale cleanup reference in the inventory reset routine must go before the
-- table does, otherwise the routine breaks on next run.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__inventory';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reset_module__inventory not found';
  END IF;

  v_new := regexp_replace(
    v_def,
    'WITH d AS \(DELETE FROM public\.reconciliation_sessions.*?jsonb_build_object\(''reconciliation_sessions'', n\);',
    '',
    'ns'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'expected reconciliation_sessions cleanup block not found in reset_module__inventory';
  END IF;

  IF position('public.reconciliation_sessions' IN v_new) > 0 THEN
    RAISE EXCEPTION 'reset_module__inventory still references reconciliation_sessions';
  END IF;

  EXECUTE v_new;
END $$;

ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS reconciliation_session_id;
DROP TABLE IF EXISTS public.reconciliation_sessions;