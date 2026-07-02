
CREATE OR REPLACE FUNCTION public.notify_me_when_app_launches(_app_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  -- Look up active org from user_active_business if present, else null is fine
  SELECT b.organization_id INTO _org
    FROM public.user_active_business uab
    LEFT JOIN public.businesses b ON b.id = uab.business_id
   WHERE uab.user_id = _uid
   LIMIT 1;

  INSERT INTO public.app_launch_notifications (user_id, organization_id, app_id)
  VALUES (_uid, _org, _app_id)
  ON CONFLICT DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NULL THEN
    SELECT id INTO _id FROM public.app_launch_notifications
     WHERE user_id = _uid AND app_id = _app_id
       AND ((_org IS NULL AND organization_id IS NULL) OR organization_id = _org)
     LIMIT 1;
  END IF;
  RETURN _id;
END $$;

-- Unique index to make the ON CONFLICT idempotent
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_launch_notifications_user_org_app
  ON public.app_launch_notifications (user_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), app_id);

CREATE OR REPLACE FUNCTION public.request_app_access(_app_id text, _message text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _req_id uuid;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT b.organization_id INTO _org
    FROM public.user_active_business uab
    JOIN public.businesses b ON b.id = uab.business_id
   WHERE uab.user_id = _uid
   LIMIT 1;

  IF _org IS NULL THEN
    RAISE EXCEPTION 'No active organization';
  END IF;

  INSERT INTO public.approval_requests (
    organization_id, requested_by, request_type, status, request_data
  )
  VALUES (
    _org, _uid, 'app_access',
    'pending',
    jsonb_build_object(
      'app_id', _app_id,
      'message', COALESCE(_message, ''),
      'requested_at', now()
    )
  )
  RETURNING id INTO _req_id;

  RETURN _req_id;
END $$;
