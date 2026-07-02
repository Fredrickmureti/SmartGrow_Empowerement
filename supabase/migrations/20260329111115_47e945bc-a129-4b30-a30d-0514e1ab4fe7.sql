
-- Migrate accountant → internal + assign "Accountant" group
DO $$
DECLARE
  rec RECORD;
  v_group_id uuid;
BEGIN
  FOR rec IN SELECT id, user_id, organization_id FROM user_roles WHERE role = 'accountant' AND is_active = true LOOP
    SELECT pg.id INTO v_group_id FROM permission_groups pg WHERE pg.organization_id = rec.organization_id AND pg.name = 'Accountant' LIMIT 1;
    IF v_group_id IS NOT NULL THEN
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (rec.organization_id, rec.user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE user_roles SET role = 'internal' WHERE id = rec.id;
  END LOOP;
END;
$$;

-- Migrate cashier → internal + assign "Cashier" group
DO $$
DECLARE
  rec RECORD;
  v_group_id uuid;
BEGIN
  FOR rec IN SELECT id, user_id, organization_id FROM user_roles WHERE role = 'cashier' AND is_active = true LOOP
    SELECT pg.id INTO v_group_id FROM permission_groups pg WHERE pg.organization_id = rec.organization_id AND pg.name = 'Cashier' LIMIT 1;
    IF v_group_id IS NOT NULL THEN
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (rec.organization_id, rec.user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE user_roles SET role = 'internal' WHERE id = rec.id;
  END LOOP;
END;
$$;

-- Migrate staff → internal + assign "Staff" group
DO $$
DECLARE
  rec RECORD;
  v_group_id uuid;
BEGIN
  FOR rec IN SELECT id, user_id, organization_id FROM user_roles WHERE role = 'staff' AND is_active = true LOOP
    SELECT pg.id INTO v_group_id FROM permission_groups pg WHERE pg.organization_id = rec.organization_id AND pg.name = 'Staff' LIMIT 1;
    IF v_group_id IS NOT NULL THEN
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (rec.organization_id, rec.user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE user_roles SET role = 'internal' WHERE id = rec.id;
  END LOOP;
END;
$$;

-- Migrate viewer → internal + assign "Viewer (Read-Only)" group
DO $$
DECLARE
  rec RECORD;
  v_group_id uuid;
BEGIN
  FOR rec IN SELECT id, user_id, organization_id FROM user_roles WHERE role = 'viewer' AND is_active = true LOOP
    SELECT pg.id INTO v_group_id FROM permission_groups pg WHERE pg.organization_id = rec.organization_id AND pg.name = 'Viewer (Read-Only)' LIMIT 1;
    IF v_group_id IS NOT NULL THEN
      INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
      VALUES (rec.organization_id, rec.user_id, v_group_id)
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE user_roles SET role = 'internal' WHERE id = rec.id;
  END LOOP;
END;
$$;

-- Update promote_to_internal_user to use 'internal' as default
CREATE OR REPLACE FUNCTION public.promote_to_internal_user(
  p_user_id uuid,
  p_org_id uuid,
  p_new_role public.app_role DEFAULT 'internal'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result json;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid()
    AND organization_id = p_org_id
    AND role IN ('owner', 'admin', 'super_admin')
    AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not an admin of this organization';
  END IF;

  UPDATE user_roles
  SET user_type = 'internal', role = p_new_role, updated_at = now()
  WHERE user_id = p_user_id AND organization_id = p_org_id AND is_active = true;

  DELETE FROM member_permission_groups WHERE user_id = p_user_id AND organization_id = p_org_id;

  INSERT INTO member_permission_groups (organization_id, user_id, permission_group_id)
  SELECT p_org_id, p_user_id, pg.id
  FROM permission_groups pg
  WHERE pg.organization_id = p_org_id AND pg.name = 'Internal Users' AND pg.is_system = true
  ON CONFLICT DO NOTHING;

  SELECT json_build_object('success', true, 'role', p_new_role) INTO v_result;
  RETURN v_result;
END;
$$;
