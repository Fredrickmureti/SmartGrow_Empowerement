-- ============================================================
-- Generic Platform Integration Provider Framework
-- ============================================================

-- 1. CAPABILITIES — what kinds of providers exist
CREATE TABLE IF NOT EXISTS public.platform_integration_capabilities (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text,
  default_test_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. PROVIDERS — concrete providers per capability
CREATE TABLE IF NOT EXISTS public.platform_integration_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL REFERENCES public.platform_integration_capabilities(key) ON DELETE CASCADE,
  provider_key text NOT NULL,
  display_name text NOT NULL,
  description text,
  docs_url text,
  credential_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_builtin boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_key, provider_key)
);

-- 3. CONNECTIONS — per-platform configured providers (one platform = one row per active provider/capability)
CREATE TABLE IF NOT EXISTS public.platform_integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL REFERENCES public.platform_integration_capabilities(key) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES public.platform_integration_providers(id) ON DELETE CASCADE,
  display_label text,
  is_active boolean NOT NULL DEFAULT false,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb, -- non-secret config (api keys live here for now; encrypted vault optional later)
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_refresh_enabled boolean NOT NULL DEFAULT false,
  auto_refresh_interval_hours int NOT NULL DEFAULT 24 CHECK (auto_refresh_interval_hours BETWEEN 1 AND 720),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_message text,
  last_run_at timestamptz,
  last_run_status text,
  last_run_message text,
  next_run_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only one active connection per capability
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_connection_per_capability
  ON public.platform_integration_connections (capability_key)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pic_capability ON public.platform_integration_connections (capability_key);
CREATE INDEX IF NOT EXISTS idx_pic_next_run ON public.platform_integration_connections (next_run_at) WHERE auto_refresh_enabled = true AND is_active = true;

-- 4. RUNS — audit log of every test/manual/scheduled run
CREATE TABLE IF NOT EXISTS public.platform_integration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.platform_integration_connections(id) ON DELETE CASCADE,
  capability_key text NOT NULL,
  provider_id uuid,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled', 'test')),
  triggered_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  message text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pir_connection ON public.platform_integration_runs (connection_id, started_at DESC);

-- ============================================================
-- Triggers for updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at_integration()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_pip_updated ON public.platform_integration_providers;
CREATE TRIGGER trg_pip_updated BEFORE UPDATE ON public.platform_integration_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_integration();

DROP TRIGGER IF EXISTS trg_pic_updated ON public.platform_integration_connections;
CREATE TRIGGER trg_pic_updated BEFORE UPDATE ON public.platform_integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_integration();

-- ============================================================
-- RLS — platform admins only
-- ============================================================
ALTER TABLE public.platform_integration_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_integration_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_integration_runs ENABLE ROW LEVEL SECURITY;

-- Capabilities + providers are public catalogs to platform admins (read), only super-admin writes
DROP POLICY IF EXISTS "admins read capabilities" ON public.platform_integration_capabilities;
CREATE POLICY "admins read capabilities" ON public.platform_integration_capabilities
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins manage capabilities" ON public.platform_integration_capabilities;
CREATE POLICY "admins manage capabilities" ON public.platform_integration_capabilities
  FOR ALL TO authenticated USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins read providers" ON public.platform_integration_providers;
CREATE POLICY "admins read providers" ON public.platform_integration_providers
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins manage providers" ON public.platform_integration_providers;
CREATE POLICY "admins manage providers" ON public.platform_integration_providers
  FOR ALL TO authenticated USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins read connections" ON public.platform_integration_connections;
CREATE POLICY "admins read connections" ON public.platform_integration_connections
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins manage connections" ON public.platform_integration_connections;
CREATE POLICY "admins manage connections" ON public.platform_integration_connections
  FOR ALL TO authenticated USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins read runs" ON public.platform_integration_runs;
CREATE POLICY "admins read runs" ON public.platform_integration_runs
  FOR SELECT TO authenticated USING (public.is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "admins manage runs" ON public.platform_integration_runs;
CREATE POLICY "admins manage runs" ON public.platform_integration_runs
  FOR ALL TO authenticated USING (public.is_platform_admin(auth.uid())) WITH CHECK (public.is_platform_admin(auth.uid()));

-- ============================================================
-- Seed capabilities
-- ============================================================
INSERT INTO public.platform_integration_capabilities (key, name, description, default_test_payload) VALUES
  ('exchange_rates', 'Currency exchange rates', 'Live FX rate providers used to refresh platform_exchange_rates from external sources.', '{"base":"USD"}'::jsonb),
  ('sms', 'SMS gateway', 'Outbound SMS providers (e.g., Twilio, Africa''s Talking).', '{"to":"+10000000000","message":"test"}'::jsonb),
  ('email', 'Transactional email', 'Outbound email providers (e.g., Resend, SendGrid, Postmark).', '{"to":"test@example.com","subject":"test"}'::jsonb),
  ('payments', 'Payment gateway', 'Card / mobile-money / wallet payment providers.', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description;

-- ============================================================
-- Seed exchange-rate providers
-- ============================================================
INSERT INTO public.platform_integration_providers
  (capability_key, provider_key, display_name, description, docs_url, credential_schema, sort_order)
VALUES
  ('exchange_rates', 'exchangerate_host',
   'exchangerate.host',
   'Free public API. No API key required for the open endpoint. Best for getting started.',
   'https://exchangerate.host/',
   '{"api_key":{"type":"string","label":"API key (optional, for higher rate limits)","secret":true,"required":false}}'::jsonb,
   10),

  ('exchange_rates', 'openexchangerates',
   'Open Exchange Rates',
   'Reliable, widely used. Free tier: 1,000 requests/month, USD base only.',
   'https://openexchangerates.org/',
   '{"app_id":{"type":"string","label":"App ID","secret":true,"required":true}}'::jsonb,
   20),

  ('exchange_rates', 'fixer',
   'Fixer.io',
   'European Central Bank-backed rates. Free tier requires EUR base; paid plans support USD.',
   'https://fixer.io/',
   '{"access_key":{"type":"string","label":"Access key","secret":true,"required":true}}'::jsonb,
   30),

  ('exchange_rates', 'freecurrencyapi',
   'Free Currency API',
   'Generous free tier (5,000 req/month). Simple JSON, USD base on free plan.',
   'https://freecurrencyapi.com/',
   '{"api_key":{"type":"string","label":"API key","secret":true,"required":true}}'::jsonb,
   40)
ON CONFLICT (capability_key, provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  docs_url = EXCLUDED.docs_url,
  credential_schema = EXCLUDED.credential_schema,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- ============================================================
-- Helper to schedule next_run_at on save
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_integration_next_run()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auto_refresh_enabled AND NEW.is_active THEN
    NEW.next_run_at := COALESCE(NEW.last_run_at, now()) + (NEW.auto_refresh_interval_hours || ' hours')::interval;
  ELSE
    NEW.next_run_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pic_next_run ON public.platform_integration_connections;
CREATE TRIGGER trg_pic_next_run BEFORE INSERT OR UPDATE OF auto_refresh_enabled, auto_refresh_interval_hours, last_run_at, is_active
  ON public.platform_integration_connections
  FOR EACH ROW EXECUTE FUNCTION public.recompute_integration_next_run();