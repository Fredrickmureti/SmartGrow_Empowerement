
-- ============================================================
-- Phase 1: scanner_sessions + scanner_session_pairings
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scanner_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  label text NOT NULL,
  target_kind text NOT NULL DEFAULT 'session',
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '8 hours'),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scanner_sessions_org_idx ON public.scanner_sessions(organization_id);
CREATE INDEX IF NOT EXISTS scanner_sessions_creator_idx ON public.scanner_sessions(created_by);

ALTER TABLE public.scanner_sessions ENABLE ROW LEVEL SECURITY;

-- Block direct writes — only the SECURITY DEFINER RPCs may mutate.
CREATE POLICY scanner_sessions_no_direct_write
  ON public.scanner_sessions AS RESTRICTIVE FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

CREATE POLICY scanner_sessions_select_owner
  ON public.scanner_sessions FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = scanner_sessions.organization_id
        AND ur.is_active = true
    )
  );

CREATE TABLE IF NOT EXISTS public.scanner_session_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES public.scanner_sessions(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  branch_id uuid,
  organization_id uuid NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_by_user uuid,
  claimed_device_label text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scanner_session_pairings_session_idx
  ON public.scanner_session_pairings(session_id);

ALTER TABLE public.scanner_session_pairings ENABLE ROW LEVEL SECURITY;

CREATE POLICY scanner_session_pairings_no_direct_write
  ON public.scanner_session_pairings AS RESTRICTIVE FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

-- ============================================================
-- RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_scanner_session(
  p_business_id uuid,
  p_branch_id uuid,
  p_label text,
  p_target_kind text DEFAULT 'session'
) RETURNS TABLE(id uuid, label text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_exp timestamptz := now() + interval '8 hours';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_business_id IS NULL THEN RAISE EXCEPTION 'business_id required'; END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE businesses.id = p_business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'business not found' USING ERRCODE = '42704'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.organization_id = v_org AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'No active role in organization' USING ERRCODE = '42501';
  END IF;

  IF p_branch_id IS NOT NULL AND NOT public.user_can_access_branch(v_uid, p_branch_id) THEN
    RAISE EXCEPTION 'No access to branch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.scanner_sessions(
    organization_id, business_id, branch_id, label, target_kind, created_by, expires_at
  ) VALUES (
    v_org, p_business_id, p_branch_id, COALESCE(NULLIF(p_label,''),'Scanner session'), p_target_kind, v_uid, v_exp
  ) RETURNING scanner_sessions.id INTO v_id;

  RETURN QUERY SELECT v_id, COALESCE(NULLIF(p_label,''),'Scanner session'), v_exp;
END $$;

CREATE OR REPLACE FUNCTION public.create_scanner_session_pairing(
  p_session_id uuid
) RETURNS TABLE(token text, expires_at timestamptz, session_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_s record;
  v_token text;
  v_exp timestamptz := now() + interval '60 seconds';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_s FROM public.scanner_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = '42704'; END IF;
  IF v_s.revoked_at IS NOT NULL OR v_s.expires_at < now() THEN
    RAISE EXCEPTION 'session inactive' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.organization_id = v_s.organization_id AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'No access' USING ERRCODE = '42501';
  END IF;

  IF v_s.branch_id IS NOT NULL AND NOT public.user_can_access_branch(v_uid, v_s.branch_id) THEN
    RAISE EXCEPTION 'No branch access' USING ERRCODE = '42501';
  END IF;

  v_token := encode(gen_random_bytes(24), 'base64');
  v_token := translate(v_token, '+/=', '-_');

  INSERT INTO public.scanner_session_pairings(
    token, session_id, business_id, branch_id, organization_id, created_by, expires_at
  ) VALUES (
    v_token, v_s.id, v_s.business_id, v_s.branch_id, v_s.organization_id, v_uid, v_exp
  );

  RETURN QUERY SELECT v_token, v_exp, v_s.id;
END $$;

CREATE OR REPLACE FUNCTION public.claim_scanner_session_pairing(
  p_token text,
  p_device_label text
) RETURNS TABLE(
  session_id uuid,
  business_id uuid,
  branch_id uuid,
  organization_id uuid,
  channel_key text,
  label text,
  target_kind text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p record;
  v_s record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_p FROM public.scanner_session_pairings WHERE token = p_token FOR UPDATE;
  IF v_p.id IS NULL THEN RAISE EXCEPTION 'pairing not found' USING ERRCODE = '42704'; END IF;
  IF v_p.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'pairing already claimed' USING ERRCODE = '22023'; END IF;
  IF v_p.revoked_at IS NOT NULL OR v_p.expires_at < now() THEN
    RAISE EXCEPTION 'pairing expired' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.organization_id = v_p.organization_id AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'No access' USING ERRCODE = '42501';
  END IF;
  IF v_p.branch_id IS NOT NULL AND NOT public.user_can_access_branch(v_uid, v_p.branch_id) THEN
    RAISE EXCEPTION 'No branch access' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_s FROM public.scanner_sessions WHERE id = v_p.session_id;

  UPDATE public.scanner_session_pairings
    SET claimed_at = now(), claimed_by_user = v_uid, claimed_device_label = p_device_label
    WHERE id = v_p.id;

  RETURN QUERY SELECT
    v_s.id, v_s.business_id, v_s.branch_id, v_s.organization_id,
    ('scan:session:' || v_s.id::text), v_s.label, v_s.target_kind;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_scanner_session(
  p_session_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_s record;
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_s FROM public.scanner_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RETURN 0; END IF;
  IF v_s.created_by <> v_uid AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_uid AND ur.organization_id = v_s.organization_id
      AND ur.is_active = true AND ur.role IN ('admin','owner')
  ) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE public.scanner_sessions SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = p_session_id;
  UPDATE public.scanner_session_pairings SET revoked_at = COALESCE(revoked_at, now())
    WHERE session_id = p_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count + 1;
END $$;

-- ============================================================
-- Realtime channel access function — extends pos:scan:* with scan:session:*
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_access_scan_channel(p_topic text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_org uuid;
  v_branch uuid;
BEGIN
  IF v_uid IS NULL OR p_topic IS NULL THEN RETURN false; END IF;

  IF position('pos:scan:' in p_topic) = 1 THEN
    RETURN public.can_access_pos_scan_channel(p_topic);
  END IF;

  IF position('scan:session:' in p_topic) = 1 THEN
    BEGIN
      v_id := substring(p_topic from 14)::uuid;
    EXCEPTION WHEN others THEN RETURN false; END;

    SELECT organization_id, branch_id INTO v_org, v_branch
      FROM public.scanner_sessions WHERE id = v_id AND revoked_at IS NULL AND expires_at > now();
    IF v_org IS NULL THEN RETURN false; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_uid AND organization_id = v_org AND is_active = true
    ) THEN RETURN false; END IF;

    IF v_branch IS NOT NULL AND NOT public.user_can_access_branch(v_uid, v_branch) THEN
      RETURN false;
    END IF;

    RETURN true;
  END IF;

  RETURN false;
END $$;

-- ============================================================
-- realtime.messages policies — extend to cover scan:session:* topics
-- ============================================================

DROP POLICY IF EXISTS scan_session_channel_read ON realtime.messages;
DROP POLICY IF EXISTS scan_session_channel_write ON realtime.messages;

CREATE POLICY scan_session_channel_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.topic() LIKE 'scan:session:%' AND public.can_access_scan_channel(realtime.topic()));

CREATE POLICY scan_session_channel_write ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'scan:session:%' AND public.can_access_scan_channel(realtime.topic()));

-- ============================================================
-- Purge job: piggyback on existing nightly schedule by adding pg_cron entry
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'scanner-sessions-purge',
      '15 3 * * *',
      $cron$
        DELETE FROM public.scanner_session_pairings WHERE created_at < now() - interval '24 hours';
        DELETE FROM public.scanner_sessions
          WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '24 hours')
             OR (expires_at < now() - interval '24 hours');
      $cron$
    );
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;
