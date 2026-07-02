-- =============================================================
-- 1. Idempotency constraints
-- =============================================================

-- Departments: unique per Company by name (case-insensitive via lower())
CREATE UNIQUE INDEX IF NOT EXISTS departments_business_name_unique
  ON public.departments (business_id, lower(name))
  WHERE business_id IS NOT NULL;

-- Branches: unique per Company by name (so we can safely auto-create "Main Branch")
CREATE UNIQUE INDEX IF NOT EXISTS branches_business_name_unique
  ON public.branches (business_id, lower(name));

-- =============================================================
-- 2. Helper: ensure every active Company has a default branch.
--    Returns nothing; safe to call repeatedly.
-- =============================================================
CREATE OR REPLACE FUNCTION public.ensure_default_branch_for_business(
  p_org_id uuid,
  p_business_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_branch_id uuid;
BEGIN
  -- Prefer headquarters
  SELECT id INTO v_branch_id
  FROM public.branches
  WHERE business_id = p_business_id AND is_active = true
  ORDER BY (is_headquarters IS TRUE) DESC, created_at ASC
  LIMIT 1;

  IF v_branch_id IS NOT NULL THEN
    RETURN v_branch_id;
  END IF;

  -- None — create "Main Branch" as headquarters
  INSERT INTO public.branches (
    organization_id, business_id, name, code,
    is_headquarters, is_active
  )
  VALUES (
    p_org_id, p_business_id, 'Main Branch', 'MAIN',
    true, true
  )
  ON CONFLICT (business_id, lower(name)) DO NOTHING
  RETURNING id INTO v_branch_id;

  IF v_branch_id IS NULL THEN
    SELECT id INTO v_branch_id
    FROM public.branches
    WHERE business_id = p_business_id AND lower(name) = 'main branch'
    LIMIT 1;
  END IF;

  RETURN v_branch_id;
END;
$$;

-- =============================================================
-- 3. Rewrite seed_app_data: tenant-aware, branch-aware, idempotent
-- =============================================================
CREATE OR REPLACE FUNCTION public.seed_app_data(p_org_id uuid, p_app_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_business RECORD;
  v_branch_id uuid;
  v_business_count int;
  v_hr_manager_group_id uuid;
  v_internal_group_id uuid;
  v_pos_group_id uuid;
  v_crm_group_id uuid;
BEGIN
  -- All app installs require at least one Company in the org
  -- (organization-level data like leave_types and crm_pipeline_stages
  --  doesn't strictly need a Company, but everything else does).
  SELECT COUNT(*) INTO v_business_count
  FROM public.businesses
  WHERE organization_id = p_org_id AND is_active = true;

  IF p_app_id IN ('hr','pos') AND v_business_count = 0 THEN
    RAISE EXCEPTION 'SETUP_REQUIRED: % requires at least one active Company. Create a Company first, then install this app.',
      p_app_id
      USING ERRCODE = 'P0001',
            HINT = 'no_business';
  END IF;

  -- ============================================================
  -- HR APP
  -- ============================================================
  IF p_app_id = 'hr' THEN
    -- Org-level: leave types
    INSERT INTO public.leave_types (organization_id, name, code, color, requires_approval, is_paid, is_active, max_consecutive_days)
    VALUES
      (p_org_id, 'Annual Leave',       'AL', '#3B82F6', true,  true,  true, 30),
      (p_org_id, 'Sick Leave',          'SL', '#EF4444', true,  true,  true, 10),
      (p_org_id, 'Maternity Leave',     'ML', '#EC4899', true,  true,  true, 90),
      (p_org_id, 'Paternity Leave',     'PL', '#8B5CF6', true,  true,  true, 14),
      (p_org_id, 'Unpaid Leave',        'UL', '#6B7280', true,  false, true, 30),
      (p_org_id, 'Compassionate Leave', 'CL', '#F59E0B', true,  true,  true, 5)
    ON CONFLICT DO NOTHING;

    -- Per-Company: default departments
    FOR v_business IN
      SELECT id FROM public.businesses
      WHERE organization_id = p_org_id AND is_active = true
    LOOP
      INSERT INTO public.departments (organization_id, business_id, name, is_active)
      VALUES
        (p_org_id, v_business.id, 'Human Resources', true),
        (p_org_id, v_business.id, 'Administration', true),
        (p_org_id, v_business.id, 'Operations',     true)
      ON CONFLICT (business_id, lower(name)) DO NOTHING;
    END LOOP;

    -- Org-level: HR Manager permission group + rules
    SELECT id INTO v_hr_manager_group_id
    FROM public.permission_groups
    WHERE organization_id = p_org_id AND name = 'HR Manager'
    LIMIT 1;

    IF v_hr_manager_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system, is_active)
      VALUES (p_org_id, 'HR Manager', 'Full access to HR, Leave, Payroll, and Timesheets modules', true, true)
      RETURNING id INTO v_hr_manager_group_id;
    END IF;

    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
    VALUES
      (v_hr_manager_group_id, 'hr',         true, true, true, true),
      (v_hr_manager_group_id, 'leave',      true, true, true, true),
      (v_hr_manager_group_id, 'payroll',    true, true, true, true),
      (v_hr_manager_group_id, 'timesheets', true, true, true, true),
      (v_hr_manager_group_id, 'employees',  true, true, true, true)
    ON CONFLICT (permission_group_id, module) DO NOTHING;

    SELECT id INTO v_internal_group_id
    FROM public.permission_groups
    WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true
    LIMIT 1;

    IF v_internal_group_id IS NOT NULL THEN
      UPDATE public.permission_group_rules
      SET can_create = false, can_write = false, can_delete = false
      WHERE permission_group_id = v_internal_group_id
        AND module IN ('hr','payroll')
        AND can_create = true;

      INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
      VALUES (v_internal_group_id, 'employees', true, false, false, false)
      ON CONFLICT (permission_group_id, module) DO NOTHING;
    END IF;
  END IF;

  -- ============================================================
  -- POS APP
  -- ============================================================
  IF p_app_id = 'pos' THEN
    -- Permission group (org-level)
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

    -- Per-Company seeding: ensure default branch + register + config
    FOR v_business IN
      SELECT id FROM public.businesses
      WHERE organization_id = p_org_id AND is_active = true
    LOOP
      v_branch_id := public.ensure_default_branch_for_business(p_org_id, v_business.id);

      IF v_branch_id IS NULL THEN
        RAISE EXCEPTION 'SETUP_REQUIRED: Could not ensure a default branch for Company %.', v_business.id
          USING ERRCODE = 'P0001', HINT = 'no_branch';
      END IF;

      -- Register (one default per Company)
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

      -- Payment methods (per-Company)
      INSERT INTO public.pos_payment_methods (organization_id, business_id, method_key, display_name, is_enabled, requires_reference, icon, sort_order)
      VALUES
        (p_org_id, v_business.id, 'cash',          'Cash',          true,  false, 'Banknote',   1),
        (p_org_id, v_business.id, 'card',          'Card',          true,  true,  'CreditCard', 2),
        (p_org_id, v_business.id, 'mobile_money',  'Mobile Money',  true,  true,  'Smartphone', 3),
        (p_org_id, v_business.id, 'bank_transfer', 'Bank Transfer', true,  true,  'Building',   4)
      ON CONFLICT (organization_id, method_key) DO NOTHING;

      -- General settings row (per-Company)
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

      -- Security settings (org+business unique)
      INSERT INTO public.pos_security_settings (organization_id, business_id)
      VALUES (p_org_id, v_business.id)
      ON CONFLICT (organization_id) DO NOTHING;

      -- GL mappings skeleton (per-Company)
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

      -- Discount presets (per-Company)
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
END;
$$;