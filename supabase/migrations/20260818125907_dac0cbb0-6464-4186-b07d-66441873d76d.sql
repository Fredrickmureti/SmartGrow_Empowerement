-- =====================================================================
-- Finance Wave 2 · Phase 14 — the feed connection model (D-13 / D-14).
-- Every imported bank line must trace to a run, and every run to a
-- connection. The edge function becomes transport only.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.bank_feed_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  provider_id uuid,
  provider_code text NOT NULL,
  external_account_id text,
  status text NOT NULL DEFAULT 'active',
  sync_from_date date,
  sync_frequency text NOT NULL DEFAULT 'daily',
  auto_sync_enabled boolean NOT NULL DEFAULT false,
  last_success_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_feed_connections_status_chk
    CHECK (status IN ('active','needs_reauth','disabled','error')),
  CONSTRAINT bank_feed_connections_frequency_chk
    CHECK (sync_frequency IN ('manual','hourly','daily','weekly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_connections_one_per_account
  ON public.bank_feed_connections (bank_account_id)
  WHERE status <> 'disabled';

CREATE TABLE IF NOT EXISTS public.bank_feed_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.bank_feed_connections(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running',
  trigger_source text NOT NULL DEFAULT 'manual',
  window_from date,
  window_to date,
  fetched_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  statement_id uuid REFERENCES public.bank_statements(id) ON DELETE SET NULL,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  started_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_feed_runs_status_chk
    CHECK (status IN ('running','succeeded','partial','failed')),
  CONSTRAINT bank_feed_runs_trigger_chk
    CHECK (trigger_source IN ('manual','schedule','webhook','backfill'))
);

CREATE INDEX IF NOT EXISTS bank_feed_runs_account_started_idx
  ON public.bank_feed_runs (bank_account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS bank_feed_runs_connection_idx
  ON public.bank_feed_runs (connection_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_runs_one_in_flight
  ON public.bank_feed_runs (connection_id)
  WHERE status = 'running';

-- Read-only for the client; every write goes through the seams below.
GRANT SELECT ON public.bank_feed_connections TO authenticated;
GRANT SELECT ON public.bank_feed_runs TO authenticated;
GRANT ALL ON public.bank_feed_connections TO service_role;
GRANT ALL ON public.bank_feed_runs TO service_role;

ALTER TABLE public.bank_feed_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_feed_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_feed_connections_select_perm"
  ON public.bank_feed_connections FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read')
    AND public.user_can_access_business(auth.uid(), business_id)
  );

CREATE POLICY "bank_feed_runs_select_perm"
  ON public.bank_feed_runs FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'financials', 'read')
    AND public.user_can_access_business(auth.uid(), business_id)
  );

CREATE TRIGGER bank_feed_connections_touch
  BEFORE UPDATE ON public.bank_feed_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER bank_feed_runs_touch
  BEFORE UPDATE ON public.bank_feed_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- Seam: resolve (or provision) the connection for an account.
-- Scope columns are derived from the parent account, never passed in.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_feed_connection_resolve(
  _bank_account_id uuid,
  _user_id uuid DEFAULT NULL
) RETURNS public.bank_feed_connections
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _acct public.bank_accounts;
  _conn public.bank_feed_connections;
  _code text;
BEGIN
  SELECT * INTO _acct FROM public.bank_accounts WHERE id = _bank_account_id;
  IF _acct.id IS NULL THEN
    RAISE EXCEPTION 'BANK_FEED_ACCOUNT_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _acct.business_id IS NULL THEN
    RAISE EXCEPTION 'BANK_FEED_ACCOUNT_NOT_SCOPED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _conn
    FROM public.bank_feed_connections
   WHERE bank_account_id = _bank_account_id
     AND status <> 'disabled'
   LIMIT 1;

  IF _conn.id IS NOT NULL THEN
    RETURN _conn;
  END IF;

  SELECT provider_code INTO _code
    FROM public.platform_bank_providers WHERE id = _acct.provider_id;

  INSERT INTO public.bank_feed_connections (
    organization_id, business_id, bank_account_id, provider_id, provider_code,
    external_account_id, sync_from_date, sync_frequency, auto_sync_enabled, created_by
  ) VALUES (
    _acct.organization_id, _acct.business_id, _acct.id, _acct.provider_id,
    COALESCE(_code, 'manual'), _acct.external_account_id, _acct.sync_from_date,
    COALESCE(_acct.sync_frequency, 'daily'), COALESCE(_acct.auto_sync_enabled, false), _user_id
  )
  RETURNING * INTO _conn;

  RETURN _conn;
END;
$$;

-- ---------------------------------------------------------------------
-- Seam: start a run. Refuses a second in-flight run for the connection.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_feed_run_start(
  _bank_account_id uuid,
  _window_from date,
  _window_to date,
  _trigger_source text DEFAULT 'manual',
  _user_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _conn public.bank_feed_connections;
  _run public.bank_feed_runs;
BEGIN
  _conn := public.bank_feed_connection_resolve(_bank_account_id, _user_id);

  IF _conn.status = 'needs_reauth' THEN
    RAISE EXCEPTION 'BANK_FEED_NEEDS_REAUTH' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.bank_feed_runs (
      organization_id, business_id, connection_id, bank_account_id,
      trigger_source, window_from, window_to, started_by
    ) VALUES (
      _conn.organization_id, _conn.business_id, _conn.id, _conn.bank_account_id,
      COALESCE(_trigger_source, 'manual'), _window_from, _window_to, _user_id
    )
    RETURNING * INTO _run;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'BANK_FEED_RUN_IN_FLIGHT' USING ERRCODE = '55006';
  END;

  UPDATE public.bank_feed_connections
     SET last_run_at = now(), updated_at = now()
   WHERE id = _conn.id;

  RETURN jsonb_build_object(
    'run_id', _run.id,
    'connection_id', _conn.id,
    'business_id', _conn.business_id,
    'provider_code', _conn.provider_code,
    'window_from', _run.window_from,
    'window_to', _run.window_to
  );
END;
$$;

-- ---------------------------------------------------------------------
-- Seam: finish a run with the ingestion engine's own counts.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_feed_run_finish(
  _run_id uuid,
  _fetched integer,
  _inserted integer,
  _duplicates integer,
  _rejected integer,
  _statement_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run public.bank_feed_runs;
  _status text;
BEGIN
  SELECT * INTO _run FROM public.bank_feed_runs WHERE id = _run_id FOR UPDATE;
  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'BANK_FEED_RUN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _run.status <> 'running' THEN
    RETURN jsonb_build_object('run_id', _run.id, 'status', _run.status, 'idempotent', true);
  END IF;

  _status := CASE WHEN COALESCE(_rejected, 0) > 0 THEN 'partial' ELSE 'succeeded' END;

  UPDATE public.bank_feed_runs SET
    status = _status,
    fetched_count = COALESCE(_fetched, 0),
    inserted_count = COALESCE(_inserted, 0),
    duplicate_count = COALESCE(_duplicates, 0),
    rejected_count = COALESCE(_rejected, 0),
    statement_id = _statement_id,
    finished_at = now(),
    updated_at = now()
  WHERE id = _run_id;

  UPDATE public.bank_feed_connections SET
    last_success_at = now(),
    last_error = NULL,
    consecutive_failures = 0,
    status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
    updated_at = now()
  WHERE id = _run.connection_id;

  RETURN jsonb_build_object('run_id', _run.id, 'status', _status);
END;
$$;

-- ---------------------------------------------------------------------
-- Seam: fail a run. The connection records the reason, so a broken feed
-- is visible instead of silently empty.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_feed_run_fail(
  _run_id uuid,
  _error_code text,
  _error_message text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run public.bank_feed_runs;
BEGIN
  SELECT * INTO _run FROM public.bank_feed_runs WHERE id = _run_id FOR UPDATE;
  IF _run.id IS NULL THEN
    RAISE EXCEPTION 'BANK_FEED_RUN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF _run.status <> 'running' THEN
    RETURN jsonb_build_object('run_id', _run.id, 'status', _run.status, 'idempotent', true);
  END IF;

  UPDATE public.bank_feed_runs SET
    status = 'failed',
    error_code = _error_code,
    error_message = left(COALESCE(_error_message, ''), 2000),
    finished_at = now(),
    updated_at = now()
  WHERE id = _run_id;

  UPDATE public.bank_feed_connections SET
    last_error = left(COALESCE(_error_message, _error_code, 'unknown feed error'), 2000),
    consecutive_failures = consecutive_failures + 1,
    status = CASE
      WHEN _error_code IN ('BANK_FEED_AUTH','BANK_FEED_NEEDS_REAUTH') THEN 'needs_reauth'
      ELSE 'error'
    END,
    updated_at = now()
  WHERE id = _run.connection_id;

  RETURN jsonb_build_object('run_id', _run.id, 'status', 'failed');
END;
$$;

-- The feed seams are transport-side only: service_role, never the browser.
REVOKE ALL ON FUNCTION public.bank_feed_connection_resolve(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_feed_connection_resolve(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bank_feed_connection_resolve(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.bank_feed_run_start(uuid, date, date, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_feed_run_start(uuid, date, date, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bank_feed_run_start(uuid, date, date, text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.bank_feed_run_finish(uuid, integer, integer, integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_feed_run_finish(uuid, integer, integer, integer, integer, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bank_feed_run_finish(uuid, integer, integer, integer, integer, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.bank_feed_run_fail(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_feed_run_fail(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.bank_feed_run_fail(uuid, text, text) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.bank_feed_connection_resolve(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_feed_run_start(uuid, date, date, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_feed_run_finish(uuid, integer, integer, integer, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bank_feed_run_fail(uuid, text, text) TO service_role;

-- Backfill a connection for every account that already has a provider feed.
INSERT INTO public.bank_feed_connections (
  organization_id, business_id, bank_account_id, provider_id, provider_code,
  external_account_id, sync_from_date, sync_frequency, auto_sync_enabled, last_success_at, last_error
)
SELECT a.organization_id, a.business_id, a.id, a.provider_id,
       COALESCE(p.provider_code, 'manual'), a.external_account_id, a.sync_from_date,
       COALESCE(a.sync_frequency, 'daily'), COALESCE(a.auto_sync_enabled, false),
       a.last_sync_at, a.sync_error
  FROM public.bank_accounts a
  LEFT JOIN public.platform_bank_providers p ON p.id = a.provider_id
 WHERE a.provider_id IS NOT NULL
   AND a.business_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.bank_feed_connections c
      WHERE c.bank_account_id = a.id AND c.status <> 'disabled'
   );