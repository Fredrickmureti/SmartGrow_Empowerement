-- Platform email provider settings: admin-managed via security definer RPCs

CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND is_active = true
      AND role IN ('super_admin','owner')
  )
$$;

CREATE OR REPLACE FUNCTION public.get_email_provider_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_object_agg(setting_key, setting_value)
  INTO v
  FROM public.platform_settings
  WHERE setting_key IN (
    'resend_api_key','resend_from_email','resend_from_name',
    'support_reply_to_email','platform_admin_reply_to_email'
  );

  v := COALESCE(v, '{}'::jsonb);

  RETURN jsonb_build_object(
    'resend_from_email', v->>'resend_from_email',
    'resend_from_name', v->>'resend_from_name',
    'support_reply_to_email', v->>'support_reply_to_email',
    'platform_admin_reply_to_email', v->>'platform_admin_reply_to_email',
    'has_api_key', COALESCE(length(trim(COALESCE(v->>'resend_api_key',''))) > 0, false),
    'api_key_hint', CASE
      WHEN COALESCE(length(trim(COALESCE(v->>'resend_api_key',''))), 0) > 6
      THEN left(v->>'resend_api_key', 3) || '••••' || right(v->>'resend_api_key', 4)
      ELSE NULL END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_email_provider_settings(
  _resend_api_key text DEFAULT NULL,
  _resend_from_email text DEFAULT NULL,
  _resend_from_name text DEFAULT NULL,
  _support_reply_to_email text DEFAULT NULL,
  _platform_admin_reply_to_email text DEFAULT NULL,
  _clear_api_key boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pairs jsonb := '[]'::jsonb;
  item jsonb;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF _clear_api_key THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','resend_api_key','v',NULL,'s',true));
  ELSIF _resend_api_key IS NOT NULL AND length(trim(_resend_api_key)) > 0 THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','resend_api_key','v',trim(_resend_api_key),'s',true));
  END IF;

  IF _resend_from_email IS NOT NULL THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','resend_from_email','v',NULLIF(trim(_resend_from_email),''),'s',false));
  END IF;
  IF _resend_from_name IS NOT NULL THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','resend_from_name','v',NULLIF(trim(_resend_from_name),''),'s',false));
  END IF;
  IF _support_reply_to_email IS NOT NULL THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','support_reply_to_email','v',NULLIF(trim(_support_reply_to_email),''),'s',false));
  END IF;
  IF _platform_admin_reply_to_email IS NOT NULL THEN
    pairs := pairs || jsonb_build_array(jsonb_build_object('k','platform_admin_reply_to_email','v',NULLIF(trim(_platform_admin_reply_to_email),''),'s',false));
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(pairs) LOOP
    INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, is_secret, description)
    VALUES (item->>'k', item->>'v', 'string', (item->>'s')::boolean, 'Email delivery configuration')
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = EXCLUDED.setting_value,
          is_secret = EXCLUDED.is_secret,
          updated_at = now();
  END LOOP;

  RETURN public.get_email_provider_settings();
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_provider_settings() FROM public;
REVOKE ALL ON FUNCTION public.set_email_provider_settings(text,text,text,text,text,boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_email_provider_settings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_email_provider_settings(text,text,text,text,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated;

UPDATE public.platform_settings SET is_secret = true WHERE setting_key = 'resend_api_key';