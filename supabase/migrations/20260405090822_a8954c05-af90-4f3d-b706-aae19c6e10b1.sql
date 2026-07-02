
-- Phase 1: Platform Identity, Ownership & Operator RBAC

-- 1. Create platform_admin_role enum
CREATE TYPE public.platform_admin_role AS ENUM ('owner', 'admin', 'operator');

-- 2. Alter platform_admins: add role + invitation columns
ALTER TABLE public.platform_admins
  ADD COLUMN role public.platform_admin_role NOT NULL DEFAULT 'admin',
  ADD COLUMN invited_email text,
  ADD COLUMN invited_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deactivated_by uuid;

-- Set the original seed admin as owner
UPDATE public.platform_admins
SET role = 'owner'
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'fredrickmureti612@gmail.com' LIMIT 1);

-- 3. Create platform_admin_groups
CREATE TABLE public.platform_admin_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admin_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view groups"
  ON public.platform_admin_groups FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Owner and admin can manage groups"
  ON public.platform_admin_groups FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')));

-- 4. Create platform_admin_group_permissions
CREATE TABLE public.platform_admin_group_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.platform_admin_groups(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  UNIQUE(group_id, permission_key)
);

ALTER TABLE public.platform_admin_group_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view group permissions"
  ON public.platform_admin_group_permissions FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Owner and admin can manage group permissions"
  ON public.platform_admin_group_permissions FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')));

-- 5. Create platform_admin_group_members
CREATE TABLE public.platform_admin_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.platform_admins(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.platform_admin_groups(id) ON DELETE CASCADE,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(admin_id, group_id)
);

ALTER TABLE public.platform_admin_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view group members"
  ON public.platform_admin_group_members FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "Owner and admin can manage group members"
  ON public.platform_admin_group_members FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role IN ('owner', 'admin')));

-- 6. Create platform_ownership_transfers
CREATE TABLE public.platform_ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL,
  to_user_id uuid NOT NULL,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  initiated_by uuid NOT NULL,
  verification_token text NOT NULL UNIQUE,
  verified_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'completed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  notes text
);

ALTER TABLE public.platform_ownership_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner can view transfers"
  ON public.platform_ownership_transfers FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role = 'owner'));

CREATE POLICY "Owner can create transfers"
  ON public.platform_ownership_transfers FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid() AND is_active = true AND role = 'owner'));

-- 7. Seed default system groups with permissions
INSERT INTO public.platform_admin_groups (name, description, is_system) VALUES
  ('Full Access', 'Complete access to all platform admin areas', true),
  ('Support', 'View organizations, users, and audit logs', true),
  ('Billing', 'Manage billing, plans, and organization subscriptions', true),
  ('Localization', 'Manage localization packs and translations', true),
  ('Reports', 'View analytics and reports', true),
  ('Technical Ops', 'Manage infrastructure, email, and platform settings', true);

-- Seed permissions for each group
INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES
  ('organizations.view'), ('organizations.manage'),
  ('billing.view'), ('billing.manage'),
  ('users.view'), ('users.manage'),
  ('settings.view'), ('settings.manage'),
  ('analytics.view'), ('reports.view'),
  ('localization.manage'), ('email.manage'),
  ('audit_log.view'), ('plans.manage'),
  ('infrastructure.manage'), ('demo_requests.manage'),
  ('team.view'), ('team.manage')
) AS p(key)
WHERE g.name = 'Full Access';

INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES ('organizations.view'), ('users.view'), ('audit_log.view')) AS p(key)
WHERE g.name = 'Support';

INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES ('organizations.view'), ('billing.view'), ('billing.manage'), ('plans.manage')) AS p(key)
WHERE g.name = 'Billing';

INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES ('localization.manage')) AS p(key)
WHERE g.name = 'Localization';

INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES ('analytics.view'), ('reports.view'), ('organizations.view')) AS p(key)
WHERE g.name = 'Reports';

INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key FROM public.platform_admin_groups g
CROSS JOIN (VALUES ('infrastructure.manage'), ('settings.view'), ('email.manage')) AS p(key)
WHERE g.name = 'Technical Ops';

-- 8. Create SECURITY DEFINER function for platform admin permission checks
CREATE OR REPLACE FUNCTION public.get_platform_admin_permissions(_user_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM platform_admins WHERE user_id = _user_id AND is_active = true AND role = 'owner'
    ) THEN
      -- Owner gets all permissions
      ARRAY(SELECT DISTINCT permission_key FROM platform_admin_group_permissions)
    WHEN EXISTS (
      SELECT 1 FROM platform_admins WHERE user_id = _user_id AND is_active = true AND role = 'admin'
    ) THEN
      -- Admin gets permissions from assigned groups
      ARRAY(
        SELECT DISTINCT pgp.permission_key
        FROM platform_admin_group_members pgm
        JOIN platform_admin_group_permissions pgp ON pgp.group_id = pgm.group_id
        JOIN platform_admins pa ON pa.id = pgm.admin_id
        WHERE pa.user_id = _user_id AND pa.is_active = true
      )
    WHEN EXISTS (
      SELECT 1 FROM platform_admins WHERE user_id = _user_id AND is_active = true AND role = 'operator'
    ) THEN
      -- Operator gets permissions from assigned groups
      ARRAY(
        SELECT DISTINCT pgp.permission_key
        FROM platform_admin_group_members pgm
        JOIN platform_admin_group_permissions pgp ON pgp.group_id = pgm.group_id
        JOIN platform_admins pa ON pa.id = pgm.admin_id
        WHERE pa.user_id = _user_id AND pa.is_active = true
      )
    ELSE
      ARRAY[]::text[]
  END;
$$;

-- 9. Create function to check if user has a specific platform permission
CREATE OR REPLACE FUNCTION public.has_platform_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _permission = ANY(public.get_platform_admin_permissions(_user_id));
$$;

-- 10. Create function to get platform admin role
CREATE OR REPLACE FUNCTION public.get_platform_admin_role(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM platform_admins WHERE user_id = _user_id AND is_active = true LIMIT 1;
$$;
