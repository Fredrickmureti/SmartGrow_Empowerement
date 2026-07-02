
-- =========================================================================
-- Wave 3 — Finance Settings RLS hardening
-- =========================================================================

-- 1. default_account_settings  --------------------------------------------
ALTER TABLE public.default_account_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS default_account_settings_all ON public.default_account_settings;
DROP POLICY IF EXISTS default_account_settings_select ON public.default_account_settings;
DROP POLICY IF EXISTS default_account_settings_insert_perm_v1 ON public.default_account_settings;
DROP POLICY IF EXISTS default_account_settings_update_perm_v1 ON public.default_account_settings;
DROP POLICY IF EXISTS default_account_settings_delete_perm_v1 ON public.default_account_settings;
DROP POLICY IF EXISTS default_account_settings_select_v1 ON public.default_account_settings;

CREATE POLICY default_account_settings_select_v1
  ON public.default_account_settings
  FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY default_account_settings_insert_perm_v1
  ON public.default_account_settings
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY default_account_settings_update_perm_v1
  ON public.default_account_settings
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY default_account_settings_delete_perm_v1
  ON public.default_account_settings
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

-- 2. tax_rates / tax_groups -----------------------------------------------
DROP POLICY IF EXISTS tax_rates_insert_v2 ON public.tax_rates;
DROP POLICY IF EXISTS tax_rates_update_v2 ON public.tax_rates;
DROP POLICY IF EXISTS tax_rates_delete_v2 ON public.tax_rates;
DROP POLICY IF EXISTS tax_rates_insert_perm_v3 ON public.tax_rates;
DROP POLICY IF EXISTS tax_rates_update_perm_v3 ON public.tax_rates;
DROP POLICY IF EXISTS tax_rates_delete_perm_v3 ON public.tax_rates;

CREATE POLICY tax_rates_insert_perm_v3
  ON public.tax_rates
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY tax_rates_update_perm_v3
  ON public.tax_rates
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY tax_rates_delete_perm_v3
  ON public.tax_rates
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

DROP POLICY IF EXISTS tax_groups_insert_v2 ON public.tax_groups;
DROP POLICY IF EXISTS tax_groups_update_v2 ON public.tax_groups;
DROP POLICY IF EXISTS tax_groups_delete_v2 ON public.tax_groups;
DROP POLICY IF EXISTS tax_groups_insert_perm_v3 ON public.tax_groups;
DROP POLICY IF EXISTS tax_groups_update_perm_v3 ON public.tax_groups;
DROP POLICY IF EXISTS tax_groups_delete_perm_v3 ON public.tax_groups;

CREATE POLICY tax_groups_insert_perm_v3
  ON public.tax_groups
  FOR INSERT
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY tax_groups_update_perm_v3
  ON public.tax_groups
  FOR UPDATE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

CREATE POLICY tax_groups_delete_perm_v3
  ON public.tax_groups
  FOR DELETE
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.has_finance_permission(auth.uid(), 'finance.manage_settings', business_id)
  );

-- 3. organizations.lock-date trigger gate ---------------------------------
-- Org-level lock dates are touched by LockDatesCard. Generic admin/owner
-- already passes the existing UPDATE policy, but we want a dedicated
-- finance-period gate so a non-finance owner cannot freeze the books.
CREATE OR REPLACE FUNCTION public.enforce_lock_date_perm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  any_business_id uuid;
BEGIN
  -- Only run if at least one of the three lock-date columns actually changed.
  IF NEW.fiscalyear_lock_date IS NOT DISTINCT FROM OLD.fiscalyear_lock_date
     AND NEW.period_lock_date IS NOT DISTINCT FROM OLD.period_lock_date
     AND NEW.tax_lock_date     IS NOT DISTINCT FROM OLD.tax_lock_date THEN
    RETURN NEW;
  END IF;

  -- Permission key 'finance.manage_periods' is org-scoped here: pass any
  -- business under this org so the function's role check sees the right
  -- organization.
  SELECT id INTO any_business_id
  FROM public.businesses
  WHERE organization_id = NEW.id
  LIMIT 1;

  IF NOT public.has_finance_permission(auth.uid(), 'finance.manage_periods', any_business_id) THEN
    RAISE EXCEPTION 'Permission denied: finance.manage_periods is required to change lock dates.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_lock_date_perm_trg ON public.organizations;
CREATE TRIGGER enforce_lock_date_perm_trg
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  WHEN (
    NEW.fiscalyear_lock_date IS DISTINCT FROM OLD.fiscalyear_lock_date
    OR NEW.period_lock_date  IS DISTINCT FROM OLD.period_lock_date
    OR NEW.tax_lock_date     IS DISTINCT FROM OLD.tax_lock_date
  )
  EXECUTE FUNCTION public.enforce_lock_date_perm();
