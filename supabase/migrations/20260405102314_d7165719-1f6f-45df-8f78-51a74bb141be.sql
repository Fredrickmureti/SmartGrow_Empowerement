
-- Platform admin invitations table
CREATE TABLE IF NOT EXISTS public.platform_admin_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  invited_by UUID NOT NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  group_ids UUID[] DEFAULT '{}',
  country_codes TEXT[] DEFAULT '{}',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  accepted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admin_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can read invitations"
  ON public.platform_admin_invitations
  FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Team managers can create invitations"
  ON public.platform_admin_invitations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_platform_admin(auth.uid()) AND (
      EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND role IN ('owner', 'admin') AND is_active = true)
      OR public.has_platform_permission(auth.uid(), 'team.manage')
    )
  );

CREATE POLICY "Team managers can update invitations"
  ON public.platform_admin_invitations
  FOR UPDATE TO authenticated
  USING (
    public.is_platform_admin(auth.uid()) AND (
      EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND role IN ('owner', 'admin') AND is_active = true)
      OR public.has_platform_permission(auth.uid(), 'team.manage')
    )
  );

CREATE UNIQUE INDEX idx_pending_invitation_email ON public.platform_admin_invitations (email) WHERE status = 'pending';

-- Platform admin sessions table
CREATE TABLE IF NOT EXISTS public.platform_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip_address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  expired_at TIMESTAMPTZ,
  forced_logout_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admin_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view own sessions"
  ON public.platform_admin_sessions
  FOR SELECT TO authenticated
  USING (
    admin_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND role IN ('owner', 'admin') AND is_active = true)
  );

CREATE POLICY "System can insert sessions"
  ON public.platform_admin_sessions
  FOR INSERT TO authenticated
  WITH CHECK (admin_user_id = auth.uid());

CREATE POLICY "Owners can update sessions"
  ON public.platform_admin_sessions
  FOR UPDATE TO authenticated
  USING (
    admin_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true)
  );

-- Accept invitation RPC
CREATE OR REPLACE FUNCTION public.accept_platform_invitation(
  _token TEXT,
  _user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _invite RECORD;
  _new_admin_id UUID;
BEGIN
  -- Find and validate invitation
  SELECT * INTO _invite
  FROM public.platform_admin_invitations
  WHERE token = _token AND status = 'pending'
  FOR UPDATE;

  IF _invite IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired invitation');
  END IF;

  IF _invite.expires_at < now() THEN
    UPDATE public.platform_admin_invitations SET status = 'expired' WHERE id = _invite.id;
    RETURN jsonb_build_object('success', false, 'error', 'Invitation has expired');
  END IF;

  -- Check email matches
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = _user_id AND lower(email) = lower(_invite.email)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Email does not match invitation');
  END IF;

  -- Check not already a platform admin
  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id AND is_active = true) THEN
    UPDATE public.platform_admin_invitations SET status = 'accepted', accepted_at = now(), accepted_by = _user_id WHERE id = _invite.id;
    RETURN jsonb_build_object('success', true, 'message', 'Already a platform admin');
  END IF;

  -- Create platform admin record
  INSERT INTO public.platform_admins (user_id, role, is_active, granted_by, invited_email, accepted_at, notes)
  VALUES (_user_id, _invite.role::platform_admin_role, true, _invite.invited_by, _invite.email, now(), _invite.notes)
  RETURNING id INTO _new_admin_id;

  -- Assign groups
  IF array_length(_invite.group_ids, 1) > 0 THEN
    INSERT INTO public.platform_admin_group_members (admin_id, group_id, assigned_by)
    SELECT _new_admin_id, unnest(_invite.group_ids), _invite.invited_by;
  END IF;

  -- Assign country scopes
  IF array_length(_invite.country_codes, 1) > 0 THEN
    INSERT INTO public.platform_admin_country_scopes (admin_id, country_code, assigned_by)
    SELECT _new_admin_id, unnest(_invite.country_codes), _invite.invited_by;
  END IF;

  -- Mark invitation accepted
  UPDATE public.platform_admin_invitations
  SET status = 'accepted', accepted_at = now(), accepted_by = _user_id
  WHERE id = _invite.id;

  -- Audit log
  INSERT INTO public.admin_audit_log (admin_user_id, action_type, details)
  VALUES (_user_id, 'platform_invitation_accepted', jsonb_build_object(
    'invitation_id', _invite.id,
    'role', _invite.role,
    'invited_by', _invite.invited_by
  ));

  -- Remove any dummy platform_admin records for this email
  DELETE FROM public.platform_admins
  WHERE user_id = '00000000-0000-0000-0000-000000000000'
    AND invited_email = _invite.email;

  RETURN jsonb_build_object('success', true, 'admin_id', _new_admin_id);
END;
$$;
