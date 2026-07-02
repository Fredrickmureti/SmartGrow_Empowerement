-- =====================================================
-- Organization Installed Apps Table
-- Tracks which apps are installed per organization
-- =====================================================

-- Create the organization_installed_apps table
CREATE TABLE public.organization_installed_apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    installed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    settings JSONB NOT NULL DEFAULT '{}',
    last_accessed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_org_app UNIQUE(organization_id, app_id)
);

-- Add indexes for performance
CREATE INDEX idx_installed_apps_org ON public.organization_installed_apps(organization_id);
CREATE INDEX idx_installed_apps_active ON public.organization_installed_apps(organization_id, is_active) WHERE is_active = true;

-- Add comments
COMMENT ON TABLE public.organization_installed_apps IS 'Tracks which apps are installed for each organization';
COMMENT ON COLUMN public.organization_installed_apps.app_id IS 'Matches app ID from the frontend APP_REGISTRY';
COMMENT ON COLUMN public.organization_installed_apps.settings IS 'App-specific configuration stored as JSON';

-- Enable Row Level Security
ALTER TABLE public.organization_installed_apps ENABLE ROW LEVEL SECURITY;

-- RLS Policies using security definer function to avoid recursion
CREATE OR REPLACE FUNCTION public.user_belongs_to_org(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = org_id
    )
$$;

-- Policy: Users can view their organization's installed apps
CREATE POLICY "Users can view org installed apps"
ON public.organization_installed_apps
FOR SELECT
TO authenticated
USING (public.user_belongs_to_org(organization_id));

-- Policy: Users with admin role can insert apps
CREATE POLICY "Admins can install apps"
ON public.organization_installed_apps
FOR INSERT
TO authenticated
WITH CHECK (
    public.user_belongs_to_org(organization_id)
    AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = organization_installed_apps.organization_id
        AND role IN ('owner', 'admin')
    )
);

-- Policy: Users with admin role can update apps
CREATE POLICY "Admins can update installed apps"
ON public.organization_installed_apps
FOR UPDATE
TO authenticated
USING (
    public.user_belongs_to_org(organization_id)
    AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = organization_installed_apps.organization_id
        AND role IN ('owner', 'admin')
    )
)
WITH CHECK (
    public.user_belongs_to_org(organization_id)
    AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = organization_installed_apps.organization_id
        AND role IN ('owner', 'admin')
    )
);

-- Policy: Owners can delete/uninstall apps
CREATE POLICY "Owners can uninstall apps"
ON public.organization_installed_apps
FOR DELETE
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = organization_installed_apps.organization_id
        AND role = 'owner'
    )
);

-- Function to auto-install default apps when organization is created
-- Uses the user from the first user_role entry for that org
CREATE OR REPLACE FUNCTION public.install_default_apps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_installer_id UUID;
BEGIN
    -- Get the first user associated with this org (the creator)
    SELECT user_id INTO v_installer_id 
    FROM public.user_roles 
    WHERE organization_id = NEW.id 
    LIMIT 1;
    
    -- Install core apps that every organization gets
    INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by)
    VALUES 
        (NEW.id, 'finance', v_installer_id),
        (NEW.id, 'sales', v_installer_id),
        (NEW.id, 'purchases', v_installer_id),
        (NEW.id, 'inventory', v_installer_id),
        (NEW.id, 'reports', v_installer_id),
        (NEW.id, 'platform', v_installer_id)
    ON CONFLICT (organization_id, app_id) DO NOTHING;
    
    RETURN NEW;
END;
$$;

-- Create trigger to auto-install apps on organization creation
DROP TRIGGER IF EXISTS trigger_install_default_apps ON public.organizations;
CREATE TRIGGER trigger_install_default_apps
    AFTER INSERT ON public.organizations
    FOR EACH ROW
    EXECUTE FUNCTION public.install_default_apps();

-- Function to update last_accessed_at
CREATE OR REPLACE FUNCTION public.update_app_last_accessed(p_org_id UUID, p_app_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.organization_installed_apps
    SET last_accessed_at = now(), updated_at = now()
    WHERE organization_id = p_org_id AND app_id = p_app_id;
END;
$$;

-- Function to install an app for an organization
CREATE OR REPLACE FUNCTION public.install_app(p_org_id UUID, p_app_id TEXT)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result public.organization_installed_apps;
BEGIN
    INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
    VALUES (p_org_id, p_app_id, auth.uid(), true)
    ON CONFLICT (organization_id, app_id) 
    DO UPDATE SET is_active = true, updated_at = now()
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;

-- Function to uninstall (deactivate) an app
CREATE OR REPLACE FUNCTION public.uninstall_app(p_org_id UUID, p_app_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Don't allow uninstalling core apps
    IF p_app_id IN ('finance', 'platform') THEN
        RAISE EXCEPTION 'Cannot uninstall core apps';
    END IF;
    
    UPDATE public.organization_installed_apps
    SET is_active = false, updated_at = now()
    WHERE organization_id = p_org_id AND app_id = p_app_id;
    
    RETURN FOUND;
END;
$$;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_installed_apps_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_update_installed_apps_timestamp
    BEFORE UPDATE ON public.organization_installed_apps
    FOR EACH ROW
    EXECUTE FUNCTION public.update_installed_apps_updated_at();

-- Migrate existing organizations: Install default apps for all existing orgs
-- Get installer from user_roles for each org
INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by)
SELECT 
    o.id, 
    app.app_id, 
    (SELECT user_id FROM public.user_roles WHERE organization_id = o.id LIMIT 1)
FROM public.organizations o
CROSS JOIN (
    VALUES ('finance'), ('sales'), ('purchases'), ('inventory'), ('reports'), ('platform')
) AS app(app_id)
ON CONFLICT (organization_id, app_id) DO NOTHING;