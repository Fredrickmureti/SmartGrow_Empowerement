
-- Create platform permission definitions table (DB-driven permission keys)
CREATE TABLE IF NOT EXISTS public.platform_permission_definitions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_permission_definitions ENABLE ROW LEVEL SECURITY;

-- Platform admins can read definitions
CREATE POLICY "Platform admins can read permission definitions"
  ON public.platform_permission_definitions
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin(auth.uid()));

-- Only owner can manage definitions
CREATE POLICY "Only owner can manage permission definitions"
  ON public.platform_permission_definitions
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE user_id = auth.uid() AND role = 'owner' AND is_active = true
    )
  );

-- Seed all 18 existing permission keys
INSERT INTO public.platform_permission_definitions (key, label, category, description, sort_order) VALUES
  ('organizations.view', 'View Organizations', 'Organizations', 'View organization list and details', 10),
  ('organizations.manage', 'Manage Organizations', 'Organizations', 'Create, edit, suspend, delete organizations', 20),
  ('users.view', 'View Users', 'Users', 'View user accounts and profiles', 30),
  ('users.manage', 'Manage Users', 'Users', 'Manage user accounts, reset passwords', 40),
  ('billing.view', 'View Billing', 'Billing & Plans', 'View subscription and billing information', 50),
  ('billing.manage', 'Manage Billing', 'Billing & Plans', 'Manage subscriptions, apply credits', 60),
  ('plans.manage', 'Manage Plans', 'Billing & Plans', 'Create and modify subscription plans', 70),
  ('analytics.view', 'View Analytics', 'Analytics & Reports', 'Access platform analytics dashboards', 80),
  ('reports.view', 'View Reports', 'Analytics & Reports', 'Access platform reports', 90),
  ('settings.view', 'View Settings', 'Settings', 'View platform configuration', 100),
  ('settings.manage', 'Manage Settings', 'Settings', 'Modify platform configuration', 110),
  ('infrastructure.manage', 'Manage Infrastructure', 'Infrastructure', 'Manage technical infrastructure settings', 120),
  ('email.manage', 'Manage Email', 'Infrastructure', 'Manage email templates and settings', 130),
  ('localization.manage', 'Manage Localization', 'Content', 'Create and edit localization packs', 140),
  ('demo_requests.manage', 'Manage Demo Requests', 'Content', 'Handle demo request submissions', 150),
  ('audit_log.view', 'View Audit Log', 'Security', 'Access the platform audit log', 160),
  ('team.view', 'View Team', 'Security', 'View platform admin team members', 170),
  ('team.manage', 'Manage Team', 'Security', 'Invite, assign roles, deactivate team members', 180)
ON CONFLICT (key) DO NOTHING;

-- Create Auditor system group (read-only)
INSERT INTO public.platform_admin_groups (name, description, is_system)
VALUES ('Auditor', 'Read-only access for executives and auditors', true)
ON CONFLICT DO NOTHING;

-- Add view-only permissions to Auditor group
INSERT INTO public.platform_admin_group_permissions (group_id, permission_key)
SELECT g.id, p.key
FROM public.platform_admin_groups g
CROSS JOIN public.platform_permission_definitions p
WHERE g.name = 'Auditor' AND p.key LIKE '%.view'
ON CONFLICT DO NOTHING;

-- Guardrail RPC: check if group assignment is allowed
CREATE OR REPLACE FUNCTION public.check_group_assignment_allowed(
  _assigner_id UUID,
  _target_admin_id UUID,
  _group_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _assigner_role TEXT;
  _group_name TEXT;
  _is_self BOOLEAN;
BEGIN
  SELECT role INTO _assigner_role
  FROM public.platform_admins
  WHERE user_id = _assigner_id AND is_active = true;

  SELECT name INTO _group_name
  FROM public.platform_admin_groups
  WHERE id = _group_id;

  IF _group_name IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Group not found');
  END IF;

  SELECT (pa.user_id = _assigner_id) INTO _is_self
  FROM public.platform_admins pa
  WHERE pa.id = _target_admin_id;

  IF _is_self THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Cannot assign groups to yourself');
  END IF;

  IF _group_name = 'Full Access' AND _assigner_role != 'owner' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'Only the platform owner can assign Full Access');
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;
