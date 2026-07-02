
-- 1. Per-device per-minute rate counter (internal)
CREATE TABLE IF NOT EXISTS public.scan_events_rate (
  device_id text NOT NULL,
  minute_bucket timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, minute_bucket)
);

ALTER TABLE public.scan_events_rate ENABLE ROW LEVEL SECURITY;

-- No one reads this from the client; only SECURITY DEFINER fns touch it.
CREATE POLICY scan_events_rate_no_access ON public.scan_events_rate
  AS RESTRICTIVE FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);

-- 2. The audit table
CREATE TABLE IF NOT EXISTS public.scan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NULL REFERENCES public.scanner_sessions(id) ON DELETE SET NULL,
  register_id uuid NULL REFERENCES public.pos_registers(id) ON DELETE SET NULL,
  organization_id uuid NOT NULL,
  branch_id uuid NULL,
  device_id text NOT NULL,
  code text NOT NULL,
  seq bigint NOT NULL,
  decoded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  latency_ms integer GENERATED ALWAYS AS (
    GREATEST(0, (EXTRACT(EPOCH FROM (received_at - decoded_at)) * 1000)::integer)
  ) STORED,
  verdict text NOT NULL CHECK (verdict IN ('ok','weighted','unknown','error','pending')),
  workflow text NULL CHECK (workflow IS NULL OR workflow IN ('identity','quantity','count','receive')),
  source text NULL CHECK (source IS NULL OR source IN ('camera','manual','wedge','phone'))
);

CREATE INDEX IF NOT EXISTS scan_events_org_recv_idx
  ON public.scan_events (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS scan_events_session_recv_idx
  ON public.scan_events (session_id, received_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_events_register_recv_idx
  ON public.scan_events (register_id, received_at DESC) WHERE register_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_events_device_decoded_idx
  ON public.scan_events (device_id, decoded_at DESC);

ALTER TABLE public.scan_events ENABLE ROW LEVEL SECURITY;

-- SELECT: org member + branch access
CREATE POLICY scan_events_select_org ON public.scan_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = scan_events.organization_id
         AND ur.is_active = true
    )
    AND (
      scan_events.branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), scan_events.branch_id)
    )
  );

-- Block all direct writes; only the SECURITY DEFINER fn may insert.
CREATE POLICY scan_events_no_direct_write ON public.scan_events
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY scan_events_no_direct_update ON public.scan_events
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY scan_events_no_direct_delete ON public.scan_events
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- 3. The sampler + rate-limiter
CREATE OR REPLACE FUNCTION public.log_scan_event(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_session_id uuid := NULLIF(p->>'session_id','')::uuid;
  v_register_id uuid := NULLIF(p->>'register_id','')::uuid;
  v_org uuid;
  v_branch uuid;
  v_device text := p->>'device_id';
  v_code text := p->>'code';
  v_seq bigint := COALESCE((p->>'seq')::bigint, 0);
  v_decoded_at timestamptz := COALESCE((p->>'decoded_at')::timestamptz, now());
  v_verdict text := COALESCE(p->>'verdict','ok');
  v_workflow text := NULLIF(p->>'workflow','');
  v_source text := NULLIF(p->>'source','');
  v_minute timestamptz := date_trunc('minute', now());
  v_count integer;
BEGIN
  -- Auth
  IF v_user IS NULL THEN
    RETURN;  -- silent: never block the operator's scan path
  END IF;

  -- Resolve org + branch from session OR register
  IF v_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.branch_id INTO v_org, v_branch
      FROM public.scanner_sessions s
     WHERE s.id = v_session_id;
  ELSIF v_register_id IS NOT NULL THEN
    SELECT r.organization_id, r.branch_id INTO v_org, v_branch
      FROM public.pos_registers r
     WHERE r.id = v_register_id;
  END IF;

  IF v_org IS NULL THEN
    RETURN;  -- unknown source; drop silently
  END IF;

  -- Caller must be an active org member
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_user
       AND ur.organization_id = v_org
       AND ur.is_active = true
  ) THEN
    RETURN;
  END IF;

  -- Validate required fields
  IF v_device IS NULL OR length(v_device) = 0 OR v_code IS NULL OR length(v_code) = 0 THEN
    RETURN;
  END IF;
  IF v_verdict NOT IN ('ok','weighted','unknown','error','pending') THEN
    RETURN;
  END IF;

  -- Rate limit: 30/min/device
  INSERT INTO public.scan_events_rate (device_id, minute_bucket, count)
    VALUES (v_device, v_minute, 1)
    ON CONFLICT (device_id, minute_bucket)
    DO UPDATE SET count = scan_events_rate.count + 1
    RETURNING count INTO v_count;
  IF v_count > 30 THEN
    RETURN;  -- over cap; drop silently
  END IF;

  INSERT INTO public.scan_events (
    session_id, register_id, organization_id, branch_id,
    device_id, code, seq, decoded_at, verdict, workflow, source
  ) VALUES (
    v_session_id, v_register_id, v_org, v_branch,
    v_device, v_code, v_seq, v_decoded_at, v_verdict, v_workflow, v_source
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_scan_event(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_scan_event(jsonb) TO authenticated;

-- 4. Nightly purge: scan_events > 30d, rate buckets > 2h
CREATE OR REPLACE FUNCTION public.purge_scan_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  DELETE FROM public.scan_events WHERE received_at < now() - interval '30 days';
  DELETE FROM public.scan_events_rate WHERE minute_bucket < now() - interval '2 hours';
END;
$$;

-- Schedule via pg_cron if available (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('scan-events-purge') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'scan-events-purge'
    );
    PERFORM cron.schedule(
      'scan-events-purge',
      '17 3 * * *',
      $cron$ SELECT public.purge_scan_events(); $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL; -- environment without pg_cron — ignore
END $$;
