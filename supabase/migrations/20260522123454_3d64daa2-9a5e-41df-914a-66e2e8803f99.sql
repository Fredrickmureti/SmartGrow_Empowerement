-- =========================================================
-- P4b: scanner_device_trust + silent reclaim RPCs
-- Roles in this project: super_admin, owner, admin, accountant,
-- staff, viewer, cashier, portal, internal.
-- scanner_sessions columns: id, organization_id, business_id,
-- branch_id, label, target_kind, created_by, expires_at,
-- revoked_at, created_at.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.scanner_device_trust (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id         uuid NOT NULL,
  branch_id           uuid NULL,
  label               text NOT NULL,
  target_kind         text NOT NULL,
  device_id           text NOT NULL,
  device_label        text NULL,
  trust_token_hash    text NOT NULL,
  trust_token_prefix  text NOT NULL,
  issued_by           uuid NOT NULL,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_reclaimed_at   timestamptz NULL,
  reclaim_count       int  NOT NULL DEFAULT 0,
  revoked_at          timestamptz NULL,
  revoked_reason      text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scanner_device_trust_org_device_unique UNIQUE (organization_id, device_id)
);

CREATE INDEX IF NOT EXISTS scanner_device_trust_org_active_idx
  ON public.scanner_device_trust(organization_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS scanner_device_trust_device_idx
  ON public.scanner_device_trust(device_id);

ALTER TABLE public.scanner_device_trust ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS scanner_device_trust_touch ON public.scanner_device_trust;
CREATE TRIGGER scanner_device_trust_touch
  BEFORE UPDATE ON public.scanner_device_trust
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ----- RLS -----
DROP POLICY IF EXISTS scanner_device_trust_select ON public.scanner_device_trust;
CREATE POLICY scanner_device_trust_select
  ON public.scanner_device_trust
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = scanner_device_trust.organization_id
        AND COALESCE(ur.is_active, true) = true
        AND ur.role IN ('super_admin','owner','admin','cashier','staff')
    )
  );

DROP POLICY IF EXISTS scanner_device_trust_no_client_writes ON public.scanner_device_trust;
CREATE POLICY scanner_device_trust_no_client_writes
  ON public.scanner_device_trust
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- ----- Helpers -----
CREATE OR REPLACE FUNCTION public._scanner_hash_trust_token(p_token text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(digest(p_token, 'sha256'), 'hex');
$$;

-- ----- RPC 1: issue / rotate trust (desk-side) -----
CREATE OR REPLACE FUNCTION public.scanner_issue_trust(
  p_session_id    uuid,
  p_device_id     text,
  p_device_label  text DEFAULT NULL
)
RETURNS TABLE (trust_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_session  public.scanner_sessions%ROWTYPE;
  v_token    text;
  v_hash     text;
  v_prefix   text;
  v_caller   uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'trust_unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF p_device_id IS NULL OR length(p_device_id) < 8 THEN
    RAISE EXCEPTION 'trust_invalid_device' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session FROM public.scanner_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trust_session_not_found' USING ERRCODE = '42704';
  END IF;
  IF v_session.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'trust_session_revoked' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_caller
      AND ur.organization_id = v_session.organization_id
      AND COALESCE(ur.is_active, true) = true
      AND ur.role IN ('super_admin','owner','admin','cashier','staff')
  ) THEN
    RAISE EXCEPTION 'trust_forbidden' USING ERRCODE = '42501';
  END IF;

  v_token  := encode(gen_random_bytes(32), 'base64');
  v_hash   := public._scanner_hash_trust_token(v_token);
  v_prefix := substr(v_token, 1, 8);

  INSERT INTO public.scanner_device_trust AS t (
    organization_id, business_id, branch_id, label, target_kind,
    device_id, device_label,
    trust_token_hash, trust_token_prefix, issued_by, last_seen_at
  )
  VALUES (
    v_session.organization_id, v_session.business_id, v_session.branch_id,
    v_session.label, v_session.target_kind,
    p_device_id, NULLIF(p_device_label, ''),
    v_hash, v_prefix, v_caller, now()
  )
  ON CONFLICT (organization_id, device_id) DO UPDATE
    SET trust_token_hash   = EXCLUDED.trust_token_hash,
        trust_token_prefix = EXCLUDED.trust_token_prefix,
        device_label       = COALESCE(EXCLUDED.device_label, t.device_label),
        business_id        = EXCLUDED.business_id,
        branch_id          = EXCLUDED.branch_id,
        label              = EXCLUDED.label,
        target_kind        = EXCLUDED.target_kind,
        issued_by          = EXCLUDED.issued_by,
        revoked_at         = NULL,
        revoked_reason     = NULL,
        last_seen_at       = now(),
        updated_at         = now();

  RETURN QUERY SELECT v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.scanner_issue_trust(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scanner_issue_trust(uuid, text, text) TO authenticated;

-- ----- RPC 2: silent reclaim (phone-side) -----
CREATE OR REPLACE FUNCTION public.scanner_reclaim_session(
  p_device_id    text,
  p_trust_token  text
)
RETURNS TABLE (
  session_id      uuid,
  channel_topic   text,
  organization_id uuid,
  business_id     uuid,
  branch_id       uuid,
  label           text,
  target_kind     text,
  expires_at      timestamptz,
  new_trust_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_trust    public.scanner_device_trust%ROWTYPE;
  v_caller   uuid := auth.uid();
  v_new_sess uuid;
  v_expires  timestamptz;
  v_token    text;
  v_hash     text;
  v_prefix   text;
  v_ttl      interval := interval '30 days';
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'trust_unauthenticated' USING ERRCODE = '42501';
  END IF;
  IF p_device_id IS NULL OR p_trust_token IS NULL THEN
    RAISE EXCEPTION 'trust_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT t.* INTO v_trust
    FROM public.scanner_device_trust t
   WHERE t.device_id = p_device_id
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_caller
          AND ur.organization_id = t.organization_id
          AND COALESCE(ur.is_active, true) = true
     )
   ORDER BY t.last_seen_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trust_invalid' USING ERRCODE = '42704';
  END IF;
  IF v_trust.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'trust_revoked' USING ERRCODE = '42501';
  END IF;
  IF v_trust.last_seen_at < (now() - v_ttl) THEN
    RAISE EXCEPTION 'trust_expired' USING ERRCODE = '42501';
  END IF;
  IF public._scanner_hash_trust_token(p_trust_token) <> v_trust.trust_token_hash THEN
    RAISE EXCEPTION 'trust_invalid' USING ERRCODE = '42501';
  END IF;

  v_expires := now() + interval '8 hours';

  INSERT INTO public.scanner_sessions (
    organization_id, business_id, branch_id,
    label, target_kind, created_by, expires_at
  )
  VALUES (
    v_trust.organization_id, v_trust.business_id, v_trust.branch_id,
    v_trust.label, v_trust.target_kind, v_caller, v_expires
  )
  RETURNING id INTO v_new_sess;

  v_token  := encode(gen_random_bytes(32), 'base64');
  v_hash   := public._scanner_hash_trust_token(v_token);
  v_prefix := substr(v_token, 1, 8);

  UPDATE public.scanner_device_trust
     SET trust_token_hash   = v_hash,
         trust_token_prefix = v_prefix,
         last_seen_at       = now(),
         last_reclaimed_at  = now(),
         reclaim_count      = reclaim_count + 1,
         updated_at         = now()
   WHERE id = v_trust.id;

  RETURN QUERY
    SELECT v_new_sess,
           'scan:session:' || v_new_sess::text,
           v_trust.organization_id,
           v_trust.business_id,
           v_trust.branch_id,
           v_trust.label,
           v_trust.target_kind,
           v_expires,
           v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.scanner_reclaim_session(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scanner_reclaim_session(text, text) TO authenticated;

-- ----- RPC 3: revoke trust (admin/cashier) -----
CREATE OR REPLACE FUNCTION public.scanner_revoke_trust(
  p_device_id text,
  p_reason    text DEFAULT 'manual'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'trust_unauthenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE public.scanner_device_trust t
     SET revoked_at = now(),
         revoked_reason = COALESCE(NULLIF(p_reason, ''), 'manual'),
         updated_at = now()
   WHERE t.device_id = p_device_id
     AND t.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_caller
          AND ur.organization_id = t.organization_id
          AND COALESCE(ur.is_active, true) = true
          AND ur.role IN ('super_admin','owner','admin','cashier','staff')
     );
END;
$$;

REVOKE ALL ON FUNCTION public.scanner_revoke_trust(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scanner_revoke_trust(text, text) TO authenticated;
