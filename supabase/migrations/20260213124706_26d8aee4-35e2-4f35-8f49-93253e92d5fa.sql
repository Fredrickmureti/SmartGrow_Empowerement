
-- 1. Permission Groups table
CREATE TABLE public.permission_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, name)
);

ALTER TABLE public.permission_groups ENABLE ROW LEVEL SECURITY;

-- 2. Permission Group Rules table
CREATE TABLE public.permission_group_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_group_id UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT false,
  can_create BOOLEAN NOT NULL DEFAULT false,
  can_write BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(permission_group_id, module)
);

ALTER TABLE public.permission_group_rules ENABLE ROW LEVEL SECURITY;

-- 3. Member Permission Groups junction table
CREATE TABLE public.member_permission_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_group_id UUID NOT NULL REFERENCES public.permission_groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id, permission_group_id)
);

ALTER TABLE public.member_permission_groups ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_permission_groups_org ON public.permission_groups(organization_id);
CREATE INDEX idx_permission_group_rules_group ON public.permission_group_rules(permission_group_id);
CREATE INDEX idx_member_permission_groups_user ON public.member_permission_groups(user_id, organization_id);
CREATE INDEX idx_member_permission_groups_group ON public.member_permission_groups(permission_group_id);

-- Helper: check admin/owner via user_roles table
CREATE OR REPLACE FUNCTION public.is_org_admin_or_owner(_user_id UUID, _organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _organization_id
      AND role IN ('owner', 'admin', 'super_admin')
      AND is_active = true
  )
$$;

-- RLS: permission_groups
CREATE POLICY "Org members can view permission groups"
ON public.permission_groups FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Admins can create permission groups"
ON public.permission_groups FOR INSERT TO authenticated
WITH CHECK (public.is_org_admin_or_owner(auth.uid(), organization_id));

CREATE POLICY "Admins can update permission groups"
ON public.permission_groups FOR UPDATE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id));

CREATE POLICY "Admins can delete non-system permission groups"
ON public.permission_groups FOR DELETE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id) AND is_system = false);

-- RLS: permission_group_rules
CREATE POLICY "Org members can view permission group rules"
ON public.permission_group_rules FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_member(auth.uid(), pg.organization_id)
));

CREATE POLICY "Admins can insert permission group rules"
ON public.permission_group_rules FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

CREATE POLICY "Admins can update permission group rules"
ON public.permission_group_rules FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

CREATE POLICY "Admins can delete permission group rules"
ON public.permission_group_rules FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.permission_groups pg
  WHERE pg.id = permission_group_id
    AND public.is_org_admin_or_owner(auth.uid(), pg.organization_id)
));

-- RLS: member_permission_groups
CREATE POLICY "Members can view own group assignments"
ON public.member_permission_groups FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.is_org_admin_or_owner(auth.uid(), organization_id));

CREATE POLICY "Admins can assign permission groups"
ON public.member_permission_groups FOR INSERT TO authenticated
WITH CHECK (public.is_org_admin_or_owner(auth.uid(), organization_id));

CREATE POLICY "Admins can remove permission group assignments"
ON public.member_permission_groups FOR DELETE TO authenticated
USING (public.is_org_admin_or_owner(auth.uid(), organization_id));

-- Updated_at trigger
CREATE TRIGGER update_permission_groups_updated_at
BEFORE UPDATE ON public.permission_groups
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
