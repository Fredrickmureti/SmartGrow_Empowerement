-- Create a SECURITY DEFINER function to safely return masked SMS config
-- This replaces direct view access, ensuring org-scoped security
CREATE OR REPLACE FUNCTION public.get_sms_config_masked(p_organization_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  business_id uuid,
  provider text,
  is_enabled boolean,
  account_sid_masked text,
  auth_token_masked text,
  sender_phone text,
  messaging_service_sid text,
  webhook_url text,
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
    c.is_enabled,
    CASE WHEN c.account_sid IS NOT NULL THEN '****' || right(c.account_sid, 4) ELSE NULL END AS account_sid_masked,
    '********'::text AS auth_token_masked,
    c.sender_phone,
    c.messaging_service_sid,
    c.webhook_url,
    c.created_by,
    c.created_at,
    c.updated_at
  FROM sms_provider_configs c
  WHERE c.organization_id = p_organization_id
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = p_organization_id
        AND ur.is_active = true
    )
  LIMIT 1;
$$;