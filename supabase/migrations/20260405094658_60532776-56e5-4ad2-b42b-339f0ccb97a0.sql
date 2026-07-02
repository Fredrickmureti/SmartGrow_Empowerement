
-- ============================================================
-- 1. platform_admin_country_scopes table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.platform_admin_country_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.platform_admins(id) ON DELETE CASCADE,
  country_code text NOT NULL,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(admin_id, country_code)
);

ALTER TABLE public.platform_admin_country_scopes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view country scopes"
  ON public.platform_admin_country_scopes FOR SELECT
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Owner/admin can manage country scopes"
  ON public.platform_admin_country_scopes FOR ALL
  TO authenticated
  USING (
    (SELECT role FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true) IN ('owner', 'admin')
  )
  WITH CHECK (
    (SELECT role FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true) IN ('owner', 'admin')
  );

CREATE INDEX idx_country_scopes_admin ON public.platform_admin_country_scopes(admin_id);
CREATE INDEX idx_country_scopes_country ON public.platform_admin_country_scopes(country_code);

-- ============================================================
-- 2. Add invitation columns to platform_admins
-- ============================================================
ALTER TABLE public.platform_admins
  ADD COLUMN IF NOT EXISTS invitation_token text,
  ADD COLUMN IF NOT EXISTS invitation_status text DEFAULT 'accepted';

-- ============================================================
-- 3. Enhance admin_audit_log
-- ============================================================
ALTER TABLE public.admin_audit_log
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS session_id text;

-- ============================================================
-- 4. get_platform_admin_scopes RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_platform_admin_scopes(_user_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    array_agg(cs.country_code ORDER BY cs.country_code),
    '{}'::text[]
  )
  FROM platform_admin_country_scopes cs
  JOIN platform_admins pa ON pa.id = cs.admin_id
  WHERE pa.user_id = _user_id AND pa.is_active = true;
$$;

-- ============================================================
-- 5. initiate_ownership_transfer RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.initiate_ownership_transfer(
  _to_user_id uuid,
  _notes text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _from_user_id uuid;
  _transfer_id uuid;
  _token text;
  _existing_pending int;
BEGIN
  -- Verify caller is the current owner
  SELECT user_id INTO _from_user_id
  FROM platform_admins
  WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true;
  
  IF _from_user_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Only the platform owner can initiate a transfer');
  END IF;

  -- Cannot transfer to self
  IF _from_user_id = _to_user_id THEN
    RETURN json_build_object('success', false, 'error', 'Cannot transfer ownership to yourself');
  END IF;

  -- Verify target is an active platform admin
  IF NOT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = _to_user_id AND is_active = true
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Target must be an active platform admin');
  END IF;

  -- Check no pending/verified transfer exists
  SELECT count(*) INTO _existing_pending
  FROM platform_ownership_transfers
  WHERE status IN ('pending', 'verified') AND from_user_id = _from_user_id;

  IF _existing_pending > 0 THEN
    RETURN json_build_object('success', false, 'error', 'A pending transfer already exists. Cancel it first.');
  END IF;

  -- Generate token
  _token := encode(gen_random_bytes(32), 'hex');
  _transfer_id := gen_random_uuid();

  INSERT INTO platform_ownership_transfers (
    id, from_user_id, to_user_id, initiated_by, initiated_at,
    verification_token, status, expires_at, notes
  ) VALUES (
    _transfer_id, _from_user_id, _to_user_id, _from_user_id, now(),
    _token, 'pending', now() + interval '72 hours', _notes
  );

  -- Audit log
  INSERT INTO admin_audit_log (admin_user_id, action_type, details)
  VALUES (_from_user_id, 'ownership_transfer_initiated', json_build_object(
    'transfer_id', _transfer_id,
    'to_user_id', _to_user_id
  ));

  RETURN json_build_object(
    'success', true,
    'transfer_id', _transfer_id,
    'token', _token,
    'expires_at', (now() + interval '72 hours')::text
  );
END;
$$;

-- ============================================================
-- 6. complete_ownership_transfer RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_ownership_transfer(
  _transfer_id uuid,
  _verification_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _transfer RECORD;
  _caller_id uuid := auth.uid();
BEGIN
  -- Find the transfer
  SELECT * INTO _transfer
  FROM platform_ownership_transfers
  WHERE id = _transfer_id
    AND verification_token = _verification_token
    AND status IN ('pending', 'verified');

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invalid or expired transfer');
  END IF;

  -- Check expiry
  IF _transfer.expires_at < now() THEN
    UPDATE platform_ownership_transfers SET status = 'expired' WHERE id = _transfer_id;
    RETURN json_build_object('success', false, 'error', 'Transfer has expired');
  END IF;

  -- Caller must be the target user
  IF _caller_id != _transfer.to_user_id THEN
    RETURN json_build_object('success', false, 'error', 'Only the designated recipient can complete this transfer');
  END IF;

  -- Atomic swap
  UPDATE platform_admins SET role = 'admin'
  WHERE user_id = _transfer.from_user_id AND role = 'owner';

  UPDATE platform_admins SET role = 'owner'
  WHERE user_id = _transfer.to_user_id;

  UPDATE platform_ownership_transfers
  SET status = 'completed', completed_at = now(), verified_at = COALESCE(verified_at, now())
  WHERE id = _transfer_id;

  -- Audit log
  INSERT INTO admin_audit_log (admin_user_id, action_type, details)
  VALUES (_caller_id, 'ownership_transfer_completed', json_build_object(
    'transfer_id', _transfer_id,
    'from_user_id', _transfer.from_user_id,
    'to_user_id', _transfer.to_user_id
  ));

  RETURN json_build_object('success', true);
END;
$$;

-- ============================================================
-- 7. cancel_ownership_transfer RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_ownership_transfer(_transfer_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
BEGIN
  -- Only owner can cancel
  IF NOT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = _caller_id AND role = 'owner' AND is_active = true
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Only the owner can cancel a transfer');
  END IF;

  UPDATE platform_ownership_transfers
  SET status = 'cancelled'
  WHERE id = _transfer_id AND status IN ('pending', 'verified') AND from_user_id = _caller_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'No pending transfer found');
  END IF;

  INSERT INTO admin_audit_log (admin_user_id, action_type, details)
  VALUES (_caller_id, 'ownership_transfer_cancelled', json_build_object('transfer_id', _transfer_id));

  RETURN json_build_object('success', true);
END;
$$;

-- ============================================================
-- 8. Prevent owner deactivation guard
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_owner_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.role = 'owner' AND NEW.is_active = false AND OLD.is_active = true THEN
    -- Check if there's a completed transfer (meaning someone else is now owner)
    IF NOT EXISTS (
      SELECT 1 FROM platform_admins WHERE role = 'owner' AND is_active = true AND id != OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot deactivate the platform owner. Transfer ownership first.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_owner_deactivation ON public.platform_admins;
CREATE TRIGGER trg_prevent_owner_deactivation
  BEFORE UPDATE ON public.platform_admins
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_owner_deactivation();

-- ============================================================
-- 9. RLS hardening on admin_audit_log
-- ============================================================
DROP POLICY IF EXISTS "Platform admins can view audit log" ON public.admin_audit_log;
CREATE POLICY "Platform admins with audit_log.view can read"
  ON public.admin_audit_log FOR SELECT
  TO authenticated
  USING (public.has_platform_permission(auth.uid(), 'audit_log.view'));

-- ============================================================
-- 10. RLS on platform_ownership_transfers
-- ============================================================
ALTER TABLE public.platform_ownership_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can view ownership transfers"
  ON public.platform_ownership_transfers FOR SELECT
  TO authenticated
  USING (
    auth.uid() IN (from_user_id, to_user_id)
    OR (SELECT role FROM platform_admins WHERE user_id = auth.uid() AND is_active = true) = 'owner'
  );
