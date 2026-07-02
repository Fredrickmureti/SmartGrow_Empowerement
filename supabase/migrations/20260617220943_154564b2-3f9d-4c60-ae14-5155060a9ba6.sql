-- Group C #3 — extend scan_events audit to non-POS workspaces.
--
-- Previously log_scan_event required either session_id or register_id to
-- resolve org+branch. Workspaces like BarcodeEnrollment, Products, and
-- ProductIdentifiersEditor have neither — so their scans were silently
-- dropped. We add a workspace_id text column (free-form short tag like
-- "enrollment", "products", "sales", "identifiers") and let the RPC
-- resolve org via the caller's active org membership when neither
-- session_id nor register_id is supplied.

ALTER TABLE public.scan_events
  ADD COLUMN IF NOT EXISTS workspace_id text NULL;

CREATE INDEX IF NOT EXISTS scan_events_workspace_id_idx
  ON public.scan_events (organization_id, workspace_id, received_at DESC)
  WHERE workspace_id IS NOT NULL;

-- Replace log_scan_event to accept workspace_id as a third anchor.
-- Resolution priority: session_id > register_id > workspace_id (caller's
-- active org). RLS / membership check still enforced — caller must be an
-- active member of the resolved org.
CREATE OR REPLACE FUNCTION public.log_scan_event(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_session_id uuid := NULLIF(p->>'session_id','')::uuid;
  v_register_id uuid := NULLIF(p->>'register_id','')::uuid;
  v_workspace_id text := NULLIF(p->>'workspace_id','');
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
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  -- Resolve org+branch by priority: session > register > workspace (active org).
  IF v_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.branch_id INTO v_org, v_branch
      FROM public.scanner_sessions s
     WHERE s.id = v_session_id;
  ELSIF v_register_id IS NOT NULL THEN
    SELECT r.organization_id, r.branch_id INTO v_org, v_branch
      FROM public.pos_registers r
     WHERE r.id = v_register_id;
  ELSIF v_workspace_id IS NOT NULL THEN
    -- Workspace-scoped scan: anchor to caller's currently-active org so
    -- the row is RLS-visible to the same org. Branch is left NULL — these
    -- workspaces are typically org-wide (Products, Identifiers, etc.).
    SELECT uab.business_id INTO v_org
      FROM public.user_active_business uab
     WHERE uab.user_id = v_user
     LIMIT 1;
    -- Fallback: if no active business set yet, pick any active membership.
    IF v_org IS NULL THEN
      SELECT ur.organization_id INTO v_org
        FROM public.user_roles ur
       WHERE ur.user_id = v_user AND ur.is_active = true
       LIMIT 1;
    END IF;
  END IF;

  IF v_org IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = v_user
       AND ur.organization_id = v_org
       AND ur.is_active = true
  ) THEN
    RETURN;
  END IF;

  IF v_device IS NULL OR length(v_device) = 0 OR v_code IS NULL OR length(v_code) = 0 THEN
    RETURN;
  END IF;
  IF v_verdict NOT IN ('ok','weighted','unknown','error','pending') THEN
    RETURN;
  END IF;

  INSERT INTO public.scan_events_rate (device_id, minute_bucket, count)
    VALUES (v_device, v_minute, 1)
    ON CONFLICT (device_id, minute_bucket)
    DO UPDATE SET count = scan_events_rate.count + 1
    RETURNING count INTO v_count;
  IF v_count > 30 THEN
    RETURN;
  END IF;

  INSERT INTO public.scan_events (
    session_id, register_id, organization_id, branch_id,
    device_id, code, seq, decoded_at, verdict, workflow, source, workspace_id
  ) VALUES (
    v_session_id, v_register_id, v_org, v_branch,
    v_device, v_code, v_seq, v_decoded_at, v_verdict, v_workflow, v_source, v_workspace_id
  );
END;
$function$;