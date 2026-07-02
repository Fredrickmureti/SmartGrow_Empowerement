-- Add full_name column for richer invitations (idempotent)
ALTER TABLE public.platform_admin_invitations
  ADD COLUMN IF NOT EXISTS full_name text;

-- Extend accept_platform_invitation to also bootstrap profile row
CREATE OR REPLACE FUNCTION public.accept_platform_invitation(_token text, _user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _invite RECORD;
  _new_admin_id UUID;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = _user_id AND lower(email) = lower(_invite.email)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Email does not match invitation');
  END IF;

  -- Bootstrap / refresh profile so display name is populated immediately.
  -- We update full_name only when the existing one is null/empty so we never
  -- clobber a name the user has already chosen for themselves.
  IF _invite.full_name IS NOT NULL AND length(trim(_invite.full_name)) > 0 THEN
    UPDATE public.profiles
    SET full_name = _invite.full_name,
        updated_at = now()
    WHERE id = _user_id
      AND (full_name IS NULL OR length(trim(full_name)) = 0);
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id AND is_active = true) THEN
    UPDATE public.platform_admin_invitations SET status = 'accepted', accepted_at = now(), accepted_by = _user_id WHERE id = _invite.id;
    RETURN jsonb_build_object('success', true, 'message', 'Already a platform admin');
  END IF;

  INSERT INTO public.platform_admins (user_id, role, is_active, granted_by, invited_email, accepted_at, notes)
  VALUES (_user_id, _invite.role::platform_admin_role, true, _invite.invited_by, _invite.email, now(), _invite.notes)
  RETURNING id INTO _new_admin_id;

  IF array_length(_invite.group_ids, 1) > 0 THEN
    INSERT INTO public.platform_admin_group_members (admin_id, group_id, assigned_by)
    SELECT _new_admin_id, unnest(_invite.group_ids), _invite.invited_by;
  END IF;

  IF array_length(_invite.country_codes, 1) > 0 THEN
    INSERT INTO public.platform_admin_country_scopes (admin_id, country_code, assigned_by)
    SELECT _new_admin_id, unnest(_invite.country_codes), _invite.invited_by;
  END IF;

  UPDATE public.platform_admin_invitations
  SET status = 'accepted', accepted_at = now(), accepted_by = _user_id
  WHERE id = _invite.id;

  INSERT INTO public.admin_audit_log (admin_user_id, action_type, details)
  VALUES (_user_id, 'platform_invitation_accepted', jsonb_build_object(
    'invitation_id', _invite.id,
    'role', _invite.role,
    'invited_by', _invite.invited_by
  ));

  DELETE FROM public.platform_admins
  WHERE user_id = '00000000-0000-0000-0000-000000000000'
    AND invited_email = _invite.email;

  RETURN jsonb_build_object('success', true, 'admin_id', _new_admin_id);
END;
$function$;