-- Create organization_settings table for storing various organization-level settings
CREATE TABLE IF NOT EXISTS public.organization_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, setting_key)
);

-- Enable RLS
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their organization settings"
ON public.organization_settings
FOR SELECT
USING (
  organization_id IN (SELECT public.get_user_organizations(auth.uid()))
);

CREATE POLICY "Admins and owners can insert organization settings"
ON public.organization_settings
FOR INSERT
WITH CHECK (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[])
);

CREATE POLICY "Admins and owners can update organization settings"
ON public.organization_settings
FOR UPDATE
USING (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[])
);

CREATE POLICY "Admins and owners can delete organization settings"
ON public.organization_settings
FOR DELETE
USING (
  public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[])
);

-- Create trigger for updated_at
CREATE TRIGGER update_organization_settings_updated_at
BEFORE UPDATE ON public.organization_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for faster lookups
CREATE INDEX idx_organization_settings_org_key ON public.organization_settings(organization_id, setting_key);