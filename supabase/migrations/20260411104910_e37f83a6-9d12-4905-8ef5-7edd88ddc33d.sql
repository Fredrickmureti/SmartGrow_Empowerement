
-- Add is_visible_in_signup column to platform_apps
ALTER TABLE public.platform_apps
ADD COLUMN IF NOT EXISTS is_visible_in_signup BOOLEAN NOT NULL DEFAULT true;

-- Hide platform app from signup selection (it's always installed)
UPDATE public.platform_apps SET is_visible_in_signup = false WHERE id = 'platform';

-- Mark contacts and reports as core (they should always be installed)
UPDATE public.platform_apps SET is_core = true WHERE id IN ('contacts', 'reports');

-- Replace the hardcoded install_default_apps trigger with a DB-driven version
CREATE OR REPLACE FUNCTION public.install_default_apps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_app_id TEXT;
BEGIN
    -- Install all apps marked as core in platform_apps
    -- Note: installed_by is NULL here because user_roles hasn't been created yet
    -- OnboardingSetup will backfill it after org creation
    FOR v_app_id IN
        SELECT id FROM public.platform_apps WHERE is_core = true AND is_available = true
    LOOP
        INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by)
        VALUES (NEW.id, v_app_id, NULL)
        ON CONFLICT (organization_id, app_id) DO NOTHING;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Ensure RLS policy allows authenticated users to read platform_apps
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'platform_apps' AND policyname = 'Authenticated users can view available apps'
    ) THEN
        CREATE POLICY "Authenticated users can view available apps"
        ON public.platform_apps FOR SELECT TO authenticated
        USING (true);
    END IF;
END $$;

-- Ensure RLS is enabled
ALTER TABLE public.platform_apps ENABLE ROW LEVEL SECURITY;

-- Allow anon users to read platform_apps too (needed during signup before auth)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'platform_apps' AND policyname = 'Anonymous users can view available apps for signup'
    ) THEN
        CREATE POLICY "Anonymous users can view available apps for signup"
        ON public.platform_apps FOR SELECT TO anon
        USING (is_available = true);
    END IF;
END $$;
