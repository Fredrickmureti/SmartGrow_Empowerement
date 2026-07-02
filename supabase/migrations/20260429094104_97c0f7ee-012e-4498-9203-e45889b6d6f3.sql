
-- 1. Patch the missing GUC bypass on the required-role mapping guard.
--    Mirrors the exact pattern used by enforce_account_lifecycle and
--    block_app_uninstall_if_dependents_active.
CREATE OR REPLACE FUNCTION public.prevent_unmapped_system_role_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _required_keys text[] := ARRAY[
    'cash','bank','accounts_receivable','accounts_payable',
    'sales_revenue','retained_earnings'
  ];
  _replacement_exists boolean;
  _reset_org         text;
  _tenant_delete_org text;
  _scheduled         text;
  _caller            uuid;
BEGIN
  -- Lifecycle bypass: if this DELETE is happening inside a platform-authorised
  -- tenant purge / reset / scheduled executor, skip the tenant-level guard.
  -- All four markers are SECURITY DEFINER controlled — they cannot be set by
  -- ordinary tenant users.
  _reset_org         := current_setting('app.reset_in_progress', true);
  _tenant_delete_org := current_setting('app.tenant_delete',     true);
  _scheduled         := current_setting('app.scheduled_executor', true);
  _caller            := auth.uid();

  IF (_reset_org IS NOT NULL AND _reset_org = OLD.organization_id::text)
     OR (_tenant_delete_org IS NOT NULL AND _tenant_delete_org = OLD.organization_id::text)
     OR (_scheduled = 'true')
     OR (_caller IS NOT NULL AND public.is_platform_admin(_caller))
  THEN
    RETURN OLD;
  END IF;

  -- Original tenant-level protection: untouched.
  IF NOT (OLD.setting_key = ANY(_required_keys)) THEN
    RETURN OLD;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.default_account_settings
     WHERE setting_key = OLD.setting_key
       AND business_id IS NOT DISTINCT FROM OLD.business_id
       AND organization_id IS NOT DISTINCT FROM OLD.organization_id
       AND id <> OLD.id
  ) INTO _replacement_exists;

  IF NOT _replacement_exists THEN
    RAISE EXCEPTION 'Cannot delete the only mapping for required system role "%". Map a replacement account first.', OLD.setting_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;

-- 2. Harden get_org_usage_counters: NULL-safe so a stale dialog call never
--    surfaces a 400. Counters are advisory; missing data must not block UX.
CREATE OR REPLACE FUNCTION public.get_org_usage_counters(_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _users_count int := 0;
  _invoices_this_month int := 0;
  _employees_count int := 0;
  _month_start date := date_trunc('month', now())::date;
BEGIN
  IF _org_id IS NULL THEN
    RETURN jsonb_build_object(
      'users_count', 0,
      'invoices_this_month', 0,
      'employees_count', 0,
      'available', false
    );
  END IF;

  SELECT count(*) INTO _users_count
  FROM public.user_roles
  WHERE organization_id = _org_id AND is_active = true;

  SELECT count(*) INTO _invoices_this_month
  FROM public.invoices
  WHERE organization_id = _org_id
    AND created_at >= _month_start;

  SELECT count(*) INTO _employees_count
  FROM public.employees
  WHERE organization_id = _org_id
    AND status = 'active';

  RETURN jsonb_build_object(
    'users_count', _users_count,
    'invoices_this_month', _invoices_this_month,
    'employees_count', _employees_count,
    'available', true
  );
END;
$$;

-- 3. Lifecycle columns on organizations (additive, defaults preserve current behaviour)
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS deletion_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reason text,
  ADD COLUMN IF NOT EXISTS deletion_requested_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_deletion_status_chk'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_deletion_status_chk
      CHECK (deletion_status IN ('active','pending_deletion','deletion_scheduled','deleting','deletion_failed','deleted'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_organizations_deletion_status
  ON public.organizations (deletion_status)
  WHERE deletion_status <> 'active';
