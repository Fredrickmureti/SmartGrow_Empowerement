-- =====================================================================
-- HR/Payroll split: refactor install_app + seed_app_data so newly split
-- apps (employees, time-off, attendance, payroll, recruitment) each
-- bootstrap their own data. Also add Sales/Inventory permission groups.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. install_app: extend SETUP_REQUIRED guard to all sub-apps + crm/sales
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.install_app(p_org_id uuid, p_app_id text)
RETURNS public.organization_installed_apps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_result public.organization_installed_apps;
  v_use_per_user boolean := false;
  v_max_apps int;
  v_current_count int;
  v_plan_name text;
  v_already_installed boolean;
  v_business_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND role IN ('owner','admin')
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: you must be an admin or owner of this organization';
  END IF;

  -- Apps that operate on Company-scoped data must have at least one Company.
  IF p_app_id IN (
    'hr','pos',
    'employees','time-off','attendance','payroll','recruitment',
    'sales','purchases','inventory','finance'
  ) THEN
    SELECT COUNT(*) INTO v_business_count
      FROM public.businesses
     WHERE organization_id = p_org_id AND is_active = true;
    IF v_business_count = 0 THEN
      RAISE EXCEPTION 'SETUP_REQUIRED: % requires at least one active Company. Create a Company first, then install this app.',
        p_app_id USING ERRCODE = 'P0001', HINT = 'no_business';
    END IF;
  END IF;

  SELECT (setting_value::boolean) INTO v_use_per_user
    FROM public.platform_settings
   WHERE setting_key = 'use_per_user_billing'
   LIMIT 1;
  v_use_per_user := COALESCE(v_use_per_user, false);

  SELECT EXISTS (
    SELECT 1 FROM public.organization_installed_apps
     WHERE organization_id = p_org_id AND app_id = p_app_id AND is_active = true
  ) INTO v_already_installed;

  IF v_use_per_user AND NOT v_already_installed AND p_app_id <> 'platform' THEN
    SELECT psp.max_installed_apps, psp.name INTO v_max_apps, v_plan_name
      FROM public.organizations o
      JOIN public.platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = p_org_id;
    IF v_max_apps IS NOT NULL THEN
      SELECT COUNT(*) INTO v_current_count
        FROM public.organization_installed_apps
       WHERE organization_id = p_org_id AND is_active = true AND app_id <> 'platform';
      IF v_current_count >= v_max_apps THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Your % plan includes % app(s). Upgrade to install more.',
          COALESCE(v_plan_name, 'current'), v_max_apps USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active)
  VALUES (p_org_id, p_app_id, auth.uid(), true)
  ON CONFLICT (organization_id, app_id) DO UPDATE SET is_active = true, updated_at = now()
  RETURNING * INTO v_result;

  PERFORM public.seed_app_data(p_org_id, p_app_id);
  RETURN v_result;
END;
$fn$;

-- ---------------------------------------------------------------------
-- 2. seed_app_data: per-sub-app bootstrap, idempotent
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id uuid, p_app_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_business RECORD;
  v_branch_id uuid;
  v_hr_manager_group_id uuid;
  v_payroll_officer_group_id uuid;
  v_recruiter_group_id uuid;
  v_internal_group_id uuid;
  v_pos_group_id uuid;
  v_crm_group_id uuid;
  v_sales_group_id uuid;
  v_inventory_group_id uuid;
BEGIN
  -- Resolve the Internal User group once; many apps tighten its rules.
  SELECT id INTO v_internal_group_id
    FROM public.permission_groups
   WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true
   LIMIT 1;

  -- ============================================================
  -- EMPLOYEES (foundation HR app)
  -- ============================================================
  IF p_app_id IN ('employees','hr') THEN
    -- Default departments per Company
    FOR v_business IN
      SELECT id FROM public.businesses
       WHERE organization_id = p_org_id AND is_active = true
    LOOP
      INSERT INTO public.departments (organization_id, business_id, name, is_active)
      VALUES
        (p_org_id, v_business.id, 'Human Resources', true),
        (p_org_id, v_business.id, 'Administration',  true),
        (p_org_id, v_business.id, 'Operations',      true)
      ON CONFLICT (business_id, lower(name)) DO NOTHING;
    END LOOP;

    -- HR Manager group covers employee admin
    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, departments, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_hr_manager_group_id, 'employees', true, true, true, true),
      (v_hr_manager_group_id, 'hr',        true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    -- Employees self-service: read-only on own employee data
    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'employees', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;

  -- ============================================================
  -- TIME OFF (leave)
  -- ============================================================
  IF p_app_id IN ('time-off','hr') THEN
    INSERT INTO public.leave_types (organization_id, name, code, color, requires_approval, is_paid, is_active, max_consecutive_days)
    VALUES
      (p_org_id, 'Annual Leave',       'AL', '#3B82F6', true,  true,  true, 30),
      (p_org_id, 'Sick Leave',          'SL', '#EF4444', true,  true,  true, 10),
      (p_org_id, 'Maternity Leave',     'ML', '#EC4899', true,  true,  true, 90),
      (p_org_id, 'Paternity Leave',     'PL', '#8B5CF6', true,  true,  true, 14),
      (p_org_id, 'Unpaid Leave',        'UL', '#6B7280', true,  false, true, 30),
      (p_org_id, 'Compassionate Leave', 'CL', '#F59E0B', true,  true,  true, 5)
    ON CONFLICT DO NOTHING;

    -- Reuse HR Manager group for leave admin
    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Manage employees, leave, and HR records', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES (v_hr_manager_group_id, 'leave', true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    -- Self-service: employees can read own leave + create requests
    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'leave', true, true, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;

  -- ============================================================
  -- ATTENDANCE / TIMESHEETS
  -- ============================================================
  IF p_app_id IN ('attendance','hr') THEN
    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES
        (v_hr_manager_group_id, 'attendance', true, true, true, true),
        (v_hr_manager_group_id, 'timesheets', true, true, true, true)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;

    -- Self-service: employees clock in/out + view own timesheets
    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES
        (v_internal_group_id, 'attendance', true, true, false, false),
        (v_internal_group_id, 'timesheets', true, true, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;

  -- ============================================================
  -- PAYROLL (segregation of duties — Officer ≠ HR Manager)
  -- ============================================================
  IF p_app_id IN ('payroll','hr') THEN
    SELECT id INTO v_payroll_officer_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'Payroll Officer'
     LIMIT 1;
    IF v_payroll_officer_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'Payroll Officer',
              'Run payroll, manage payslips, and post payroll journals — restricted to trusted finance/HR staff', true, true)
      RETURNING id INTO v_payroll_officer_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_payroll_officer_group_id, 'payroll',    true, true, true, true),
      (v_payroll_officer_group_id, 'employees',  true, false, false, false),
      (v_payroll_officer_group_id, 'financials', true, false, false, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    -- HR Manager gets read-only payroll visibility (cannot post)
    SELECT id INTO v_hr_manager_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'HR Manager'
     LIMIT 1;
    IF v_hr_manager_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_hr_manager_group_id, 'payroll', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;

    -- Self-service: employees see only own payslips (read on payroll module);
    -- row-level RLS narrows scope to their own employee_id.
    IF v_internal_group_id IS NOT NULL THEN
      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'payroll', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;

      -- Tighten any legacy over-grants from old hr seed
      UPDATE public.permission_group_rules
         SET can_create = false, can_write = false, can_delete = false
       WHERE permission_group_id = v_internal_group_id
         AND module IN ('hr','payroll')
         AND (can_create OR can_write OR can_delete);
    END IF;
  END IF;

  -- ============================================================
  -- RECRUITMENT
  -- ============================================================
  IF p_app_id IN ('recruitment','hr') THEN
    SELECT id INTO v_recruiter_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'Recruiter'
     LIMIT 1;
    IF v_recruiter_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'Recruiter',
              'Manage job postings, applicants, and the hiring pipeline', true, true)
      RETURNING id INTO v_recruiter_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_recruiter_group_id, 'recruitment', true, true, true, true),
      (v_recruiter_group_id, 'employees',   true, false, false, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;
  END IF;

  -- ============================================================
  -- POS APP (unchanged behavior)
  -- ============================================================
  IF p_app_id = 'pos' THEN
    SELECT id INTO v_pos_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'POS Manager'
     LIMIT 1;
    IF v_pos_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'POS Manager', 'Full access to Point of Sale operations, reports, and settings', true, true)
      RETURNING id INTO v_pos_group_id;
    END IF;

    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_pos_group_id, 'pos',      true, true, true, true),
      (v_pos_group_id, 'products', true, true, true, false),
      (v_pos_group_id, 'contacts', true, true, true, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    -- Per-Company seeding (registers, payment methods, settings, GL maps, discounts)
    FOR v_business IN
      SELECT id FROM public.businesses
       WHERE organization_id = p_org_id AND is_active = true
    LOOP
      v_branch_id := public.ensure_default_branch_for_business(p_org_id, v_business.id);
      IF v_branch_id IS NULL THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Could not ensure a default branch for Company %.', v_business.id
          USING ERRCODE = 'P0001', HINT = 'no_branch';
      END IF;

      INSERT INTO public.pos_registers (
        organization_id, business_id, branch_id,
        register_name, register_code,
        is_active, default_payment_methods, settings,
        require_cashier_login, auto_lock_minutes,
        require_manager_for_void, require_manager_for_discount, require_manager_for_return
      )
      VALUES (
        p_org_id, v_business.id, v_branch_id,
        'Main Register', 'MAIN',
        true, '["cash","card"]'::jsonb, '{}'::jsonb,
        true, 5, true, true, true
      )
      ON CONFLICT (organization_id, register_code) DO NOTHING;

      INSERT INTO public.pos_payment_methods (organization_id, business_id, method_key, display_name, is_enabled, requires_reference, icon, sort_order)
      VALUES
        (p_org_id, v_business.id, 'cash',          'Cash',          true,  false, 'Banknote',   1),
        (p_org_id, v_business.id, 'card',          'Card',          true,  true,  'CreditCard', 2),
        (p_org_id, v_business.id, 'mobile_money',  'Mobile Money',  true,  true,  'Smartphone', 3),
        (p_org_id, v_business.id, 'bank_transfer', 'Bank Transfer', true,  true,  'Building',   4)
      ON CONFLICT (organization_id, method_key) DO NOTHING;

      INSERT INTO public.pos_settings (
        organization_id, business_id, setting_key, setting_value,
        max_discount_percent, require_manager_for_void, require_manager_for_refund,
        require_manager_for_discount_above, manager_pin_enabled
      )
      VALUES (
        p_org_id, v_business.id, 'general',
        '{"allow_negative_stock":false,"auto_print_receipt":true,"default_customer_required":false,"enable_barcode_scanning":true,"currency_rounding":"0.01"}'::jsonb,
        100, true, true, 15, true
      )
      ON CONFLICT (organization_id, register_id, setting_key) DO NOTHING;

      INSERT INTO public.pos_security_settings (organization_id, business_id)
      VALUES (p_org_id, v_business.id)
      ON CONFLICT (organization_id) DO NOTHING;

      INSERT INTO public.pos_gl_mappings (organization_id, business_id, transaction_type, payment_method, is_active)
      VALUES
        (p_org_id, v_business.id, 'sale',   'cash',          true),
        (p_org_id, v_business.id, 'sale',   'card',          true),
        (p_org_id, v_business.id, 'sale',   'mobile_money',  true),
        (p_org_id, v_business.id, 'sale',   'bank_transfer', true),
        (p_org_id, v_business.id, 'refund', 'cash',          true),
        (p_org_id, v_business.id, 'refund', 'card',          true),
        (p_org_id, v_business.id, 'refund', 'mobile_money',  true),
        (p_org_id, v_business.id, 'refund', 'bank_transfer', true)
      ON CONFLICT (organization_id, transaction_type, payment_method) DO NOTHING;

      INSERT INTO public.pos_discounts (organization_id, business_id, name, discount_type, value, requires_approval, is_active)
      VALUES
        (p_org_id, v_business.id, 'Staff Discount',  'percentage', 10, false, true),
        (p_org_id, v_business.id, 'Senior Citizen',  'percentage', 5,  false, true),
        (p_org_id, v_business.id, 'Manager Special', 'percentage', 20, true,  true)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- ============================================================
  -- CRM APP (org-level only)
  -- ============================================================
  IF p_app_id = 'crm' THEN
    SELECT id INTO v_crm_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'Sales Manager'
     LIMIT 1;
    IF v_crm_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'Sales Manager', 'Full access to CRM pipeline, leads, and customer activities', true, true)
      RETURNING id INTO v_crm_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_crm_group_id, 'crm',      true, true, true, true),
      (v_crm_group_id, 'contacts', true, true, true, true),
      (v_crm_group_id, 'sales',    true, true, true, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    INSERT INTO public.crm_pipeline_stages (organization_id, name, sort_order, probability, is_won, is_active)
    VALUES
      (p_org_id, 'New',         1, 10,  false, true),
      (p_org_id, 'Qualified',   2, 30,  false, true),
      (p_org_id, 'Proposal',    3, 50,  false, true),
      (p_org_id, 'Negotiation', 4, 75,  false, true),
      (p_org_id, 'Won',         5, 100, true,  true)
    ON CONFLICT DO NOTHING;
  END IF;

  -- ============================================================
  -- SALES APP — Salesperson role
  -- ============================================================
  IF p_app_id = 'sales' THEN
    SELECT id INTO v_sales_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'Salesperson'
     LIMIT 1;
    IF v_sales_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'Salesperson', 'Create quotes, sales orders, and customer invoices', true, true)
      RETURNING id INTO v_sales_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_sales_group_id, 'sales',    true, true, true, false),
      (v_sales_group_id, 'contacts', true, true, true, false),
      (v_sales_group_id, 'products', true, false, false, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;
  END IF;

  -- ============================================================
  -- INVENTORY APP — Inventory Manager role
  -- ============================================================
  IF p_app_id = 'inventory' THEN
    SELECT id INTO v_inventory_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = 'Inventory Manager'
     LIMIT 1;
    IF v_inventory_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'Inventory Manager', 'Manage products, stock movements, and warehouse operations', true, true)
      RETURNING id INTO v_inventory_group_id;
    END IF;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_inventory_group_id, 'products',  true, true, true, true),
      (v_inventory_group_id, 'purchases', true, true, true, false)
    ON CONFLICT (permission_group_id, module) DO NOTHING;
  END IF;
END;
$fn$;