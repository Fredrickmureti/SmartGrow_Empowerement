
ALTER TABLE public.sms_provider_configs
  ADD COLUMN IF NOT EXISTS provider_mode text NOT NULL DEFAULT 'test'
    CHECK (provider_mode IN ('test','live')),
  ADD COLUMN IF NOT EXISTS last_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_status text,
  ADD COLUMN IF NOT EXISTS last_test_error text;

ALTER TABLE public.sms_log
  ADD COLUMN IF NOT EXISTS provider_mode text NOT NULL DEFAULT 'live'
    CHECK (provider_mode IN ('test','live')),
  ADD COLUMN IF NOT EXISTS sent_by uuid;

DROP FUNCTION IF EXISTS public.get_sms_config_masked(uuid);

CREATE OR REPLACE FUNCTION public.get_sms_config_masked(p_organization_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  business_id uuid,
  provider text,
  provider_mode text,
  is_enabled boolean,
  account_sid_masked text,
  auth_token_masked text,
  sender_phone text,
  messaging_service_sid text,
  webhook_url text,
  daily_limit integer,
  messages_sent_today integer,
  last_reset_date date,
  last_test_at timestamptz,
  last_test_status text,
  last_test_error text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.organization_id,
    c.business_id,
    c.provider::text,
    c.provider_mode,
    c.is_enabled,
    CASE
      WHEN c.account_sid IS NULL OR length(c.account_sid) < 6 THEN NULL
      ELSE left(c.account_sid, 4) || repeat('*', greatest(length(c.account_sid) - 8, 0)) || right(c.account_sid, 4)
    END AS account_sid_masked,
    CASE WHEN c.auth_token IS NULL OR c.auth_token = '' THEN '' ELSE '••••••••' END AS auth_token_masked,
    c.sender_phone,
    c.messaging_service_sid,
    c.webhook_url,
    c.daily_limit,
    c.messages_sent_today,
    c.last_reset_date,
    c.last_test_at,
    c.last_test_status,
    c.last_test_error,
    c.created_by,
    c.created_at,
    c.updated_at
  FROM public.sms_provider_configs c
  WHERE c.organization_id = p_organization_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = p_organization_id
        AND ur.is_active = true
    )
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_sms_config_masked(uuid) TO authenticated;
