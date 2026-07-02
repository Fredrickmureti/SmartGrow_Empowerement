
-- =====================================================
-- C1: Secure install_app / uninstall_app with org membership checks
-- C3: Create seed_app_data function for HR provisioning
-- M2: Unique constraint on pending invitations
-- M5: Add onboarding_status to organization_installed_apps
-- C4: Reduce default Internal User permissions (make HR/payroll read-only by default)
-- =====================================================

-- C1: Secure install_app with org membership check
CREATE OR REPLACE FUNCTION public.install_app(p_org_id UUID, p_app_id TEXT)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result public.organization_installed_apps;
BEGIN
    -- Verify caller is admin/owner of the target organization
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = p_org_id
        AND role IN ('owner', 'admin')
        AND is_active = true
    ) THEN
        RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
    END IF;

    INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
    VALUES (p_org_id, p_app_id, auth.uid(), true)
    ON CONFLICT (organization_id, app_id) 
    DO UPDATE SET is_active = true, updated_at = now()
    RETURNING * INTO v_result;
    
    -- Seed app-specific data
    PERFORM public.seed_app_data(p_org_id, p_app_id);
    
    RETURN v_result;
END;
$$;

-- C1: Secure uninstall_app with org membership check
CREATE OR REPLACE FUNCTION public.uninstall_app(p_org_id UUID, p_app_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Verify caller is admin/owner of the target organization
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid()
        AND organization_id = p_org_id
        AND role IN ('owner', 'admin')
        AND is_active = true
    ) THEN
        RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
    END IF;

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

-- M5: Add onboarding_status column to track post-install setup progress
ALTER TABLE public.organization_installed_apps 
ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending';

COMMENT ON COLUMN public.organization_installed_apps.onboarding_status IS 'Tracks setup progress: pending, setup_complete, fully_configured';

-- M2: Unique constraint on pending invitations (prevent duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_invite
ON public.organization_invitations (organization_id, lower(email))
WHERE accepted_at IS NULL;

-- C3: Create seed_app_data function - provisions app-specific defaults on install
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id UUID, p_app_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hr_manager_group_id UUID;
    v_internal_group_id UUID;
BEGIN
    -- HR app provisioning
    IF p_app_id = 'hr' THEN
        -- Create default leave types if none exist
        IF NOT EXISTS (
            SELECT 1 FROM public.leave_types WHERE organization_id = p_org_id
        ) THEN
            INSERT INTO public.leave_types (organization_id, name, code, default_days, requires_approval, is_paid, is_active)
            VALUES
                (p_org_id, 'Annual Leave', 'AL', 21, true, true, true),
                (p_org_id, 'Sick Leave', 'SL', 10, true, true, true),
                (p_org_id, 'Maternity Leave', 'ML', 90, true, true, true),
                (p_org_id, 'Paternity Leave', 'PL', 14, true, true, true),
                (p_org_id, 'Unpaid Leave', 'UL', 30, true, false, true),
                (p_org_id, 'Compassionate Leave', 'CL', 5, true, true, true);
        END IF;

        -- Create default departments if none exist
        IF NOT EXISTS (
            SELECT 1 FROM public.departments WHERE organization_id = p_org_id
        ) THEN
            INSERT INTO public.departments (organization_id, name, is_active)
            VALUES
                (p_org_id, 'Human Resources', true),
                (p_org_id, 'Administration', true),
                (p_org_id, 'Operations', true);
        END IF;

        -- Create "HR Manager" permission group if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM public.permission_groups 
            WHERE organization_id = p_org_id AND name = 'HR Manager'
        ) THEN
            INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
            VALUES (p_org_id, 'HR Manager', 'Full access to HR, Leave, Payroll, and Timesheets modules', true, true)
            RETURNING id INTO v_hr_manager_group_id;

            INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
            VALUES
                (v_hr_manager_group_id, 'hr', true, true, true, true),
                (v_hr_manager_group_id, 'leave', true, true, true, true),
                (v_hr_manager_group_id, 'payroll', true, true, true, true),
                (v_hr_manager_group_id, 'timesheets', true, true, true, true),
                (v_hr_manager_group_id, 'employees', true, true, true, true);
        END IF;

        -- C4: Update Internal User group to have read-only HR/payroll access (instead of full CRUD)
        SELECT pg.id INTO v_internal_group_id
        FROM public.permission_groups pg
        WHERE pg.organization_id = p_org_id 
          AND pg.name = 'Internal User' 
          AND pg.is_system = true;

        IF v_internal_group_id IS NOT NULL THEN
            -- Update HR-related modules to read-only for Internal Users
            UPDATE public.permission_group_rules
            SET can_create = false, can_write = false, can_delete = false
            WHERE permission_group_id = v_internal_group_id
              AND module IN ('hr', 'payroll')
              AND can_create = true;
            
            -- Ensure employees module exists with read-only
            INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
            VALUES (v_internal_group_id, 'employees', true, false, false, false)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- POS app provisioning placeholder
    IF p_app_id = 'pos' THEN
        -- Future: create default POS config, payment methods, etc.
        NULL;
    END IF;

    -- CRM app provisioning placeholder
    IF p_app_id = 'crm' THEN
        -- Future: create default pipeline stages, etc.
        NULL;
    END IF;
END;
$$;
