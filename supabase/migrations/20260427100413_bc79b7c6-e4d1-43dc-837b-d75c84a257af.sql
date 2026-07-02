-- Track A1: app_pricing_rules SELECT policy
-- Pricing is published marketing data, not secret. Anonymous marketplace
-- visitors and authenticated users both need to read active rules.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.app_pricing_rules'::regclass
      AND polname = 'app_pricing_rules_public_read'
  ) THEN
    CREATE POLICY app_pricing_rules_public_read
      ON public.app_pricing_rules
      FOR SELECT
      TO anon, authenticated
      USING (is_active = true);
  END IF;
END$$;

-- Track A2: attach audit_settings_change() trigger to the eight sensitive tables
-- The trigger function already exists; previous pass forgot to attach triggers.
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
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Only attach if the table actually exists (some may not be present yet)
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_audit_settings_change ON public.%I;',
        t
      );
      EXECUTE format(
        'CREATE TRIGGER trg_audit_settings_change
           AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.audit_settings_change();',
        t
      );
    END IF;
  END LOOP;
END$$;