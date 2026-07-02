
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id UUID, p_app_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hr_manager_group_id UUID;
    v_internal_group_id UUID;
    v_pos_group_id UUID;
    v_crm_group_id UUID;
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

        -- Update Internal User group to have read-only HR/payroll access
        SELECT pg.id INTO v_internal_group_id
        FROM public.permission_groups pg
        WHERE pg.organization_id = p_org_id 
          AND pg.name = 'Internal User' 
          AND pg.is_system = true;

        IF v_internal_group_id IS NOT NULL THEN
            UPDATE public.permission_group_rules
            SET can_create = false, can_write = false, can_delete = false
            WHERE permission_group_id = v_internal_group_id
              AND module IN ('hr', 'payroll')
              AND can_create = true;
            
            INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
            VALUES (v_internal_group_id, 'employees', true, false, false, false)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- POS app provisioning
    IF p_app_id = 'pos' THEN
        -- Create "POS Manager" permission group
        IF NOT EXISTS (
            SELECT 1 FROM public.permission_groups 
            WHERE organization_id = p_org_id AND name = 'POS Manager'
        ) THEN
            INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
            VALUES (p_org_id, 'POS Manager', 'Full access to Point of Sale operations, reports, and settings', true, true)
            RETURNING id INTO v_pos_group_id;

            INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
            VALUES
                (v_pos_group_id, 'pos', true, true, true, true),
                (v_pos_group_id, 'products', true, true, true, false),
                (v_pos_group_id, 'contacts', true, true, true, false);
        END IF;

        -- Seed default POS registers if none exist
        IF NOT EXISTS (
            SELECT 1 FROM public.pos_registers WHERE organization_id = p_org_id
        ) THEN
            INSERT INTO public.pos_registers (organization_id, name, status, is_active)
            VALUES (p_org_id, 'Main Register', 'closed', true);
        END IF;
    END IF;

    -- CRM app provisioning
    IF p_app_id = 'crm' THEN
        -- Create "Sales Manager" permission group
        IF NOT EXISTS (
            SELECT 1 FROM public.permission_groups 
            WHERE organization_id = p_org_id AND name = 'Sales Manager'
        ) THEN
            INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
            VALUES (p_org_id, 'Sales Manager', 'Full access to CRM pipeline, leads, and customer activities', true, true)
            RETURNING id INTO v_crm_group_id;

            INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
            VALUES
                (v_crm_group_id, 'crm', true, true, true, true),
                (v_crm_group_id, 'contacts', true, true, true, true),
                (v_crm_group_id, 'sales', true, true, true, false);
        END IF;

        -- Seed default CRM pipeline stages if none exist
        IF NOT EXISTS (
            SELECT 1 FROM public.crm_pipeline_stages WHERE organization_id = p_org_id
        ) THEN
            INSERT INTO public.crm_pipeline_stages (organization_id, name, sort_order, probability, is_won, is_active)
            VALUES
                (p_org_id, 'New', 1, 10, false, true),
                (p_org_id, 'Qualified', 2, 30, false, true),
                (p_org_id, 'Proposal', 3, 50, false, true),
                (p_org_id, 'Negotiation', 4, 75, false, true),
                (p_org_id, 'Won', 5, 100, true, true);
        END IF;
    END IF;
END;
$$;
