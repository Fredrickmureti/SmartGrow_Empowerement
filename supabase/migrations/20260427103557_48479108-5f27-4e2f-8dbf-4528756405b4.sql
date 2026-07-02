-- =========================================================================
-- Fix 1: De-duplicate audit triggers on the 8 sensitive settings tables
-- Each table currently has 3 triggers all calling audit_settings_change(),
-- causing 3 audit-log rows per change. Keep only trg_audit_settings_change.
-- =========================================================================
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'businesses',
    'branches',
    'branch_setting_overrides',
    'tax_rates',
    'payment_provider_configs',
    'default_account_settings',
    'notification_alert_settings',
    'pos_settings'
  ];
  legacy_names text[];
  legacy text;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Drop both legacy trigger families if present.
    legacy_names := ARRAY[
      format('audit_%s_settings', t),
      format('audit_%s', t),
      format('trg_audit_%s', t)
    ];
    FOREACH legacy IN ARRAY legacy_names LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I;', legacy, t);
    END LOOP;
  END LOOP;
END$$;

-- =========================================================================
-- Fix 2a: Odoo-style trial expiry enforcement.
-- disable_expired_app_trials():
--   1. Marks app_trial_status rows as 'expired' when expires_at < now()
--      and status='active'.
--   2. For each just-expired trial, sets the matching installed_apps row
--      to is_active=false (only when the org has no other entitlement
--      via plan_app_access or org_entitlement_overrides).
--   3. Returns (expired_count, disabled_count).
-- Idempotent and safe to call from cron.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.disable_expired_app_trials()
RETURNS TABLE(expired_count integer, disabled_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer := 0;
  v_disabled integer := 0;
BEGIN
  -- 1. Expire trials whose deadline has passed.
  WITH newly_expired AS (
    UPDATE public.app_trial_status
       SET status = 'expired',
           updated_at = now()
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < now()
    RETURNING organization_id, app_id
  )
  SELECT count(*)::int INTO v_expired FROM newly_expired;

  -- 2. Disable installed_apps for orgs that no longer have entitlement.
  WITH expired_trials AS (
    SELECT t.organization_id, t.app_id
      FROM public.app_trial_status t
     WHERE t.status = 'expired'
       AND t.expires_at < now()
  ),
  no_other_entitlement AS (
    SELECT et.organization_id, et.app_id
      FROM expired_trials et
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.organization_subscriptions os
         JOIN public.plan_app_access paa
           ON paa.plan_id = os.plan_id
        WHERE os.organization_id = et.organization_id
          AND os.status IN ('active', 'trial')
          AND paa.app_id = et.app_id
          AND paa.is_enabled = true
     )
       AND NOT EXISTS (
       SELECT 1
         FROM public.org_entitlement_overrides oe
        WHERE oe.organization_id = et.organization_id
          AND oe.app_id = et.app_id
          AND oe.is_granted = true
          AND (oe.expires_at IS NULL OR oe.expires_at > now())
     )
  ),
  disabled AS (
    UPDATE public.installed_apps ia
       SET is_active = false,
           updated_at = now()
      FROM no_other_entitlement noe
     WHERE ia.organization_id = noe.organization_id
       AND ia.app_id = noe.app_id
       AND ia.is_active = true
    RETURNING ia.id
  )
  SELECT count(*)::int INTO v_disabled FROM disabled;

  RETURN QUERY SELECT v_expired, v_disabled;
END;
$$;

GRANT EXECUTE ON FUNCTION public.disable_expired_app_trials() TO service_role;