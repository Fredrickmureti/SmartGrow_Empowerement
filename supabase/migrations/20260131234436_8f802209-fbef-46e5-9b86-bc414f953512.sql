-- =====================================================
-- Phase 1: App-Based Subscription Gating Schema
-- =====================================================

-- 1.1 Create plan_app_access table
-- Maps subscription plans to app IDs from APP_REGISTRY
CREATE TABLE IF NOT EXISTS public.plan_app_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.platform_subscription_plans(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,  -- matches APP_REGISTRY app.id (e.g., 'finance', 'hr', 'pos')
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_app_access_unique UNIQUE(plan_id, app_id)
);

-- Enable RLS
ALTER TABLE public.plan_app_access ENABLE ROW LEVEL SECURITY;

-- RLS Policies - Platform admins can manage, all authenticated can read
CREATE POLICY "Platform admins can manage plan_app_access"
ON public.plan_app_access
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    AND ur.role = 'super_admin'
  )
);

CREATE POLICY "Authenticated users can read plan_app_access"
ON public.plan_app_access
FOR SELECT
USING (auth.role() = 'authenticated');

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_plan_app_access_plan_id ON public.plan_app_access(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_app_access_app_id ON public.plan_app_access(app_id);

-- Trigger for updated_at
CREATE TRIGGER update_plan_app_access_updated_at
  BEFORE UPDATE ON public.plan_app_access
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 1.2 Add trial/expired mode settings to platform_settings
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description)
VALUES 
  ('trial_all_apps_access', 'true', 'boolean', 'Grant access to all apps during trial period'),
  ('expired_read_only_mode', 'true', 'boolean', 'Allow read-only access after subscription expires')
ON CONFLICT (setting_key) DO NOTHING;

-- 1.3 Seed default app access per plan
-- App IDs from APP_REGISTRY: finance, sales, purchases, inventory, pos, crm, hr, projects, reports, platform

-- Free Plan: Core apps only
INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, app.is_enabled
FROM public.platform_subscription_plans p
CROSS JOIN (
  VALUES 
    ('finance', true),
    ('sales', true),
    ('purchases', true),
    ('inventory', true),
    ('reports', true),
    ('platform', true),
    ('pos', false),
    ('crm', false),
    ('hr', false),
    ('projects', false)
) AS app(app_id, is_enabled)
WHERE p.name = 'Free'
ON CONFLICT (plan_id, app_id) DO NOTHING;

-- Starter Plan: Core + some productivity
INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, app.is_enabled
FROM public.platform_subscription_plans p
CROSS JOIN (
  VALUES 
    ('finance', true),
    ('sales', true),
    ('purchases', true),
    ('inventory', true),
    ('reports', true),
    ('platform', true),
    ('pos', false),
    ('crm', true),
    ('hr', false),
    ('projects', true)
) AS app(app_id, is_enabled)
WHERE p.name = 'Starter'
ON CONFLICT (plan_id, app_id) DO NOTHING;

-- Professional Plan: All apps
INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM public.platform_subscription_plans p
CROSS JOIN (
  VALUES ('finance'), ('sales'), ('purchases'), ('inventory'), 
         ('reports'), ('platform'), ('pos'), ('crm'), ('hr'), ('projects')
) AS app(app_id)
WHERE p.name = 'Professional'
ON CONFLICT (plan_id, app_id) DO NOTHING;

-- Enterprise Plan: All apps (always enabled)
INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT p.id, app.app_id, true
FROM public.platform_subscription_plans p
CROSS JOIN (
  VALUES ('finance'), ('sales'), ('purchases'), ('inventory'), 
         ('reports'), ('platform'), ('pos'), ('crm'), ('hr'), ('projects')
) AS app(app_id)
WHERE p.name = 'Enterprise'
ON CONFLICT (plan_id, app_id) DO NOTHING;