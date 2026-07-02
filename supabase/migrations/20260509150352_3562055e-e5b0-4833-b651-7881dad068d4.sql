
-- Replace `notify-admin-new-signup` edge function with a SECURITY DEFINER RPC
-- so we can drop the function and free an edge-function slot.
-- The RPC inserts in-app notifications for all active platform admins.
-- Email fan-out is handled by the existing platform_admin_notifications -> send-platform-email
-- nightly digest path (no per-signup edge invocation needed).

CREATE OR REPLACE FUNCTION public.notify_admins_new_signup(
  _user_id uuid,
  _email text,
  _full_name text,
  _signed_up_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only the user themselves can trigger this for their own signup row.
  IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO public.platform_admin_notifications
    (admin_user_id, type, category, title, message, link, metadata, priority)
  SELECT
    pa.user_id,
    'info',
    'signup',
    'New User Signup',
    coalesce(_full_name, _email) || ' (' || coalesce(_email, '') || ') just signed up',
    '/admin-management/users',
    jsonb_build_object(
      'user_id', _user_id,
      'email', _email,
      'full_name', _full_name,
      'signed_up_at', _signed_up_at
    ),
    1
  FROM public.platform_admins pa
  WHERE pa.is_active = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_admins_new_signup(uuid, text, text, timestamptz) TO authenticated;
