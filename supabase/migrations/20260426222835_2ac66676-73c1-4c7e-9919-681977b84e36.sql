-- =========================================================================
-- Phase-4 Architecture Audit: Settings & RBAC remediation
-- =========================================================================

-- B1: per-business module-permission consistency on accounts -------------
DROP POLICY IF EXISTS accounts_select_per_business ON public.accounts;
DROP POLICY IF EXISTS accounts_insert_per_business ON public.accounts;
DROP POLICY IF EXISTS accounts_update_per_business ON public.accounts;
DROP POLICY IF EXISTS accounts_delete_per_business ON public.accounts;

CREATE POLICY accounts_select_per_business ON public.accounts
  FOR SELECT USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read')
  );

CREATE POLICY accounts_insert_per_business ON public.accounts
  FOR INSERT WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  );

CREATE POLICY accounts_update_per_business ON public.accounts
  FOR UPDATE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  );

CREATE POLICY accounts_delete_per_business ON public.accounts
  FOR DELETE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
    AND (is_system = false)
  );

-- B1: bank_accounts ------------------------------------------------------
DROP POLICY IF EXISTS bank_accounts_select_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_insert_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_update_perm ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_delete_perm ON public.bank_accounts;

CREATE POLICY bank_accounts_select_perm ON public.bank_accounts
  FOR SELECT USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read')
  );

CREATE POLICY bank_accounts_insert_perm ON public.bank_accounts
  FOR INSERT WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  );

CREATE POLICY bank_accounts_update_perm ON public.bank_accounts
  FOR UPDATE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  );

CREATE POLICY bank_accounts_delete_perm ON public.bank_accounts
  FOR DELETE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
  );

-- B1: fiscal_periods -----------------------------------------------------
DROP POLICY IF EXISTS fiscal_periods_select_per_business ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_insert_per_business ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_update_per_business ON public.fiscal_periods;
DROP POLICY IF EXISTS fiscal_periods_delete_per_business ON public.fiscal_periods;

CREATE POLICY fiscal_periods_select_per_business ON public.fiscal_periods
  FOR SELECT USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'read')
  );

CREATE POLICY fiscal_periods_insert_per_business ON public.fiscal_periods
  FOR INSERT WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'create')
  );

CREATE POLICY fiscal_periods_update_per_business ON public.fiscal_periods
  FOR UPDATE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'write')
  );

CREATE POLICY fiscal_periods_delete_per_business ON public.fiscal_periods
  FOR DELETE USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'financials', 'delete')
  );

-- B2: normalize sms_provider_configs to use has_any_org_role() ----------
DROP POLICY IF EXISTS "Admins can manage SMS configs" ON public.sms_provider_configs;

CREATE POLICY sms_provider_configs_admin_manage ON public.sms_provider_configs
  FOR ALL
  USING (
    public.has_any_org_role(
      auth.uid(),
      organization_id,
      ARRAY['owner'::public.app_role, 'admin'::public.app_role, 'super_admin'::public.app_role]
    )
  )
  WITH CHECK (
    public.has_any_org_role(
      auth.uid(),
      organization_id,
      ARRAY['owner'::public.app_role, 'admin'::public.app_role, 'super_admin'::public.app_role]
    )
  );

-- B12: documents_shares & spreadsheet_shares — revoke open SELECT -------
DROP POLICY IF EXISTS "Public can view shares by token" ON public.documents_shares;
DROP POLICY IF EXISTS "Anyone can view shares for validation" ON public.spreadsheet_shares;

-- Token resolver functions for legitimate public-by-token access.
CREATE OR REPLACE FUNCTION public.resolve_document_share_by_token(_token text)
RETURNS SETOF public.documents_shares
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.documents_shares
  WHERE share_token = _token
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_document_share_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_document_share_by_token(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_spreadsheet_share_by_token(_token text)
RETURNS SETOF public.spreadsheet_shares
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.spreadsheet_shares
  WHERE access_token = _token
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_spreadsheet_share_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_spreadsheet_share_by_token(text) TO anon, authenticated;

-- B4 / B5: clarifying comments on sibling tables ------------------------
COMMENT ON TABLE public.notification_alert_settings IS
  'Org/business-level alert thresholds (low stock, invoice reminders, overdue escalation, daily digests). Operational thresholds for the whole tenant. NOT per-user — see notification_preferences for per-user delivery toggles.';

COMMENT ON TABLE public.notification_preferences IS
  'Per-user notification delivery preferences (email/push/in-app/sms by category). NOT operational thresholds — see notification_alert_settings.';

COMMENT ON TABLE public.pos_settings IS
  'Operational POS configuration (registers, discount policies, receipt behaviour). Security-related POS toggles live in pos_security_settings.';

COMMENT ON TABLE public.pos_security_settings IS
  'Security-only POS configuration (PIN policy, lockout thresholds, audit). Operational POS settings live in pos_settings.';

COMMENT ON TABLE public.sms_provider_configs IS
  'Per-org SMS provider credentials. Public-safe view: sms_provider_configs_masked.';
