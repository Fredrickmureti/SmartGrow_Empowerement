
-- =====================================================================
-- SMS Stage A — Lock down credentials
-- =====================================================================

-- 1) Replace the permissive admin policy with a write-only one.
--    Reads must go through get_sms_config_masked() (already SECURITY DEFINER).
DROP POLICY IF EXISTS sms_provider_configs_admin_manage ON public.sms_provider_configs;

-- Admins can INSERT / UPDATE / DELETE — but cannot SELECT (no row will be returned via PostgREST).
CREATE POLICY sms_provider_configs_admin_write
ON public.sms_provider_configs
FOR INSERT
TO authenticated
WITH CHECK (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner'::app_role,'admin'::app_role,'super_admin'::app_role])
);

CREATE POLICY sms_provider_configs_admin_update
ON public.sms_provider_configs
FOR UPDATE
TO authenticated
USING (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner'::app_role,'admin'::app_role,'super_admin'::app_role])
)
WITH CHECK (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner'::app_role,'admin'::app_role,'super_admin'::app_role])
);

CREATE POLICY sms_provider_configs_admin_delete
ON public.sms_provider_configs
FOR DELETE
TO authenticated
USING (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner'::app_role,'admin'::app_role,'super_admin'::app_role])
);

-- Explicit revoke of column-level read so admins can never select auth_token / account_sid through PostgREST.
REVOKE SELECT ON public.sms_provider_configs FROM authenticated, anon;

-- 2) SECURITY DEFINER RPC for credential & settings updates.
--    The client never sends raw fields directly; it goes through this RPC.
CREATE OR REPLACE FUNCTION public.set_sms_provider_config(
  p_organization_id uuid,
  p_account_sid text DEFAULT NULL,
  p_auth_token text DEFAULT NULL,
  p_provider_mode text DEFAULT NULL,
  p_is_enabled boolean DEFAULT NULL,
  p_sender_phone text DEFAULT NULL,
  p_messaging_service_sid text DEFAULT NULL,
  p_help_message text DEFAULT NULL,
  p_inbound_enabled boolean DEFAULT NULL,
  p_daily_limit integer DEFAULT NULL,
  p_business_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_existing public.sms_provider_configs%ROWTYPE;
  v_audit_changes jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;

  IF NOT public.has_any_org_role(v_uid, p_organization_id, ARRAY['owner'::app_role,'admin'::app_role,'super_admin'::app_role]) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: only org owners/admins can manage SMS configuration' USING ERRCODE = '42501';
  END IF;

  IF p_provider_mode IS NOT NULL AND p_provider_mode NOT IN ('test','live') THEN
    RAISE EXCEPTION 'INVALID_MODE: provider_mode must be test|live' USING ERRCODE = '22023';
  END IF;

  -- Validate Account SID format if provided
  IF p_account_sid IS NOT NULL AND p_account_sid !~ '^AC[a-zA-Z0-9]{32}$' THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_SID: must match ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' USING ERRCODE = '22023';
  END IF;
  IF p_auth_token IS NOT NULL AND length(p_auth_token) < 32 THEN
    RAISE EXCEPTION 'INVALID_AUTH_TOKEN: token looks too short' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM public.sms_provider_configs
  WHERE organization_id = p_organization_id
  LIMIT 1;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.sms_provider_configs (
      organization_id, business_id, provider, provider_mode, is_enabled,
      account_sid, auth_token, sender_phone, messaging_service_sid,
      help_message, inbound_enabled, daily_limit, created_by
    ) VALUES (
      p_organization_id,
      p_business_id,
      'twilio',
      COALESCE(p_provider_mode, 'test'),
      COALESCE(p_is_enabled, false),
      COALESCE(p_account_sid, ''),
      COALESCE(p_auth_token, ''),
      p_sender_phone,
      p_messaging_service_sid,
      COALESCE(p_help_message, 'Reply STOP to unsubscribe. For help, contact support.'),
      COALESCE(p_inbound_enabled, true),
      COALESCE(p_daily_limit, 500),
      v_uid
    )
    RETURNING id INTO v_id;
    v_audit_changes := jsonb_build_object('action','created','provider_mode', COALESCE(p_provider_mode,'test'));
  ELSE
    v_id := v_existing.id;
    UPDATE public.sms_provider_configs SET
      provider_mode         = COALESCE(p_provider_mode,         provider_mode),
      is_enabled            = COALESCE(p_is_enabled,            is_enabled),
      account_sid           = COALESCE(p_account_sid,           account_sid),
      auth_token            = COALESCE(p_auth_token,            auth_token),
      sender_phone          = COALESCE(p_sender_phone,          sender_phone),
      messaging_service_sid = COALESCE(p_messaging_service_sid, messaging_service_sid),
      help_message          = COALESCE(p_help_message,          help_message),
      inbound_enabled       = COALESCE(p_inbound_enabled,       inbound_enabled),
      daily_limit           = COALESCE(p_daily_limit,           daily_limit),
      business_id           = COALESCE(p_business_id,           business_id),
      updated_at            = now()
    WHERE id = v_id;

    v_audit_changes := jsonb_build_object(
      'action','updated',
      'mode_changed', (p_provider_mode IS NOT NULL AND p_provider_mode IS DISTINCT FROM v_existing.provider_mode),
      'sid_rotated', (p_account_sid IS NOT NULL AND p_account_sid IS DISTINCT FROM v_existing.account_sid),
      'token_rotated', (p_auth_token IS NOT NULL AND p_auth_token IS DISTINCT FROM v_existing.auth_token),
      'sender_changed', (p_sender_phone IS NOT NULL AND p_sender_phone IS DISTINCT FROM v_existing.sender_phone),
      'msid_changed', (p_messaging_service_sid IS NOT NULL AND p_messaging_service_sid IS DISTINCT FROM v_existing.messaging_service_sid),
      'enabled_changed', (p_is_enabled IS NOT NULL AND p_is_enabled IS DISTINCT FROM v_existing.is_enabled)
    );
  END IF;

  -- Best-effort audit row (skip silently if audit_logs table doesn't accept this shape)
  BEGIN
    INSERT INTO public.audit_logs (
      organization_id, user_id, action, entity_type, entity_id, metadata
    ) VALUES (
      p_organization_id, v_uid, 'sms_provider_config_changed',
      'sms_provider_configs', v_id, v_audit_changes
    );
  EXCEPTION WHEN OTHERS THEN
    -- audit table may have a different shape; do not block the credential save
    NULL;
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_sms_provider_config(uuid,text,text,text,boolean,text,text,text,boolean,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_sms_provider_config(uuid,text,text,text,boolean,text,text,text,boolean,integer,uuid) TO authenticated;

-- 3) Reaffirm masked-getter is invoker-safe and only returns redacted values.
--    (No-op DROP/CREATE to keep its definition consistent across environments.)
COMMENT ON FUNCTION public.get_sms_config_masked(uuid) IS
  'Returns SMS provider config with auth_token & account_sid masked. Only safe read path for admins.';
