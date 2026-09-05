-- ============================================================
-- Wave 1: Microfinance access-group vocabulary + seeding
-- ============================================================

ALTER TABLE public.permission_groups
  ADD COLUMN IF NOT EXISTS is_deprecated boolean NOT NULL DEFAULT false;

-- Retire the superseded seeder (not wired to any trigger).
DROP FUNCTION IF EXISTS public.seed_system_permission_groups(uuid);

-- ---------- Seeder ----------
CREATE OR REPLACE FUNCTION public.seed_default_permission_groups(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_name text;
  v_desc text;
  v_rule record;
  v_defs jsonb := jsonb_build_array(
    jsonb_build_object('name','Institution Admin','description','Full access to every area and branch. Not branch-restricted.'),
    jsonb_build_object('name','Branch Manager','description','Runs a branch: clients, applications and approvals within assigned branches.'),
    jsonb_build_object('name','Loan Officer','description','Onboards clients and prepares applications for their own portfolio.'),
    jsonb_build_object('name','Credit Analyst','description','Assesses and approves applications. No cash handling.'),
    jsonb_build_object('name','Cashier / Teller','description','Executes disbursements and records repayments. No approvals.'),
    jsonb_build_object('name','Accountant','description','Accounting and treasury. Lending read-only, with reversal rights.'),
    jsonb_build_object('name','Auditor','description','Read and export everywhere. No write access anywhere.')
  );
  v_def jsonb;
BEGIN
  -- Mark any legacy ERP groups as deprecated (never deleted).
  UPDATE public.permission_groups
     SET is_deprecated = true
   WHERE organization_id = p_org_id
     AND is_system = true
     AND name IN (
       'Accountant (ERP)','Attendance Officer','HR Manager','Internal User','Internal Users',
       'Payroll Admin','Payroll Officer','Portal User','Project Manager','Recruiter',
       'Sign User','Time Off Officer'
     );

  FOR v_def IN SELECT * FROM jsonb_array_elements(v_defs) LOOP
    v_name := v_def->>'name';
    v_desc := v_def->>'description';

    SELECT id INTO v_group_id
      FROM public.permission_groups
     WHERE organization_id = p_org_id AND name = v_name
     LIMIT 1;

    IF v_group_id IS NULL THEN
      INSERT INTO public.permission_groups (organization_id, name, description, is_system)
      VALUES (p_org_id, v_name, v_desc, true)
      RETURNING id INTO v_group_id;
    ELSE
      UPDATE public.permission_groups
         SET description = v_desc, is_system = true, is_deprecated = false
       WHERE id = v_group_id;
      DELETE FROM public.permission_group_rules WHERE permission_group_id = v_group_id;
    END IF;

    FOR v_rule IN
      SELECT * FROM (VALUES
        -- group_name, module, read, create, write, delete, approve, post, pay, close, reverse, export
        ('Institution Admin','clients',       true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','loan_products', true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','applications',  true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','loans',         true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','repayments',    true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','collections',   true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','accounting',    true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','treasury',      true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','reports',       true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','branches',      true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','team',          true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','settings',      true,true,true,true,true,true,true,true,true,true),
        ('Institution Admin','audit',         true,true,true,true,true,true,true,true,true,true),

        ('Branch Manager','clients',       true,true,true,true,false,false,false,false,false,true),
        ('Branch Manager','loan_products', true,false,false,false,false,false,false,false,false,false),
        ('Branch Manager','applications',  true,true,true,false,true,false,false,false,false,true),
        ('Branch Manager','loans',         true,false,true,false,false,false,false,true,false,true),
        ('Branch Manager','repayments',    true,false,false,false,false,false,false,false,false,true),
        ('Branch Manager','collections',   true,true,true,false,true,false,false,false,false,true),
        ('Branch Manager','accounting',    true,false,false,false,false,false,false,false,false,false),
        ('Branch Manager','treasury',      true,false,false,false,false,false,false,false,false,false),
        ('Branch Manager','reports',       true,false,false,false,false,false,false,false,false,true),
        ('Branch Manager','branches',      true,false,false,false,false,false,false,false,false,false),
        ('Branch Manager','team',          true,false,false,false,false,false,false,false,false,false),
        ('Branch Manager','audit',         true,false,false,false,false,false,false,false,false,false),

        ('Loan Officer','clients',       true,true,true,false,false,false,false,false,false,false),
        ('Loan Officer','loan_products', true,false,false,false,false,false,false,false,false,false),
        ('Loan Officer','applications',  true,true,true,false,false,false,false,false,false,false),
        ('Loan Officer','loans',         true,false,false,false,false,false,false,false,false,false),
        ('Loan Officer','repayments',    true,false,false,false,false,false,false,false,false,false),
        ('Loan Officer','collections',   true,false,false,false,false,false,false,false,false,false),
        ('Loan Officer','reports',       true,false,false,false,false,false,false,false,false,false),

        ('Credit Analyst','clients',       true,false,false,false,false,false,false,false,false,false),
        ('Credit Analyst','loan_products', true,false,false,false,false,false,false,false,false,false),
        ('Credit Analyst','applications',  true,false,true,false,true,false,false,false,false,true),
        ('Credit Analyst','loans',         true,false,false,false,false,false,false,false,false,false),
        ('Credit Analyst','reports',       true,false,false,false,false,false,false,false,false,true),

        ('Cashier / Teller','clients',    true,false,false,false,false,false,false,false,false,false),
        ('Cashier / Teller','loans',      true,false,false,false,false,false,true,false,false,false),
        ('Cashier / Teller','repayments', true,true,false,false,false,true,true,false,false,false),
        ('Cashier / Teller','treasury',   true,false,false,false,false,false,true,false,false,false),
        ('Cashier / Teller','reports',    true,false,false,false,false,false,false,false,false,false),

        ('Accountant','clients',     true,false,false,false,false,false,false,false,false,false),
        ('Accountant','loans',       true,false,false,false,false,false,false,false,false,true),
        ('Accountant','repayments',  true,false,false,false,false,false,false,false,true,true),
        ('Accountant','collections', true,false,false,false,false,false,false,false,false,true),
        ('Accountant','accounting',  true,true,true,true,false,true,false,true,true,true),
        ('Accountant','treasury',    true,true,true,false,false,true,true,true,true,true),
        ('Accountant','reports',     true,false,false,false,false,false,false,false,false,true),
        ('Accountant','audit',       true,false,false,false,false,false,false,false,false,true),

        ('Auditor','clients',       true,false,false,false,false,false,false,false,false,true),
        ('Auditor','loan_products', true,false,false,false,false,false,false,false,false,true),
        ('Auditor','applications',  true,false,false,false,false,false,false,false,false,true),
        ('Auditor','loans',         true,false,false,false,false,false,false,false,false,true),
        ('Auditor','repayments',    true,false,false,false,false,false,false,false,false,true),
        ('Auditor','collections',   true,false,false,false,false,false,false,false,false,true),
        ('Auditor','accounting',    true,false,false,false,false,false,false,false,false,true),
        ('Auditor','treasury',      true,false,false,false,false,false,false,false,false,true),
        ('Auditor','reports',       true,false,false,false,false,false,false,false,false,true),
        ('Auditor','branches',      true,false,false,false,false,false,false,false,false,true),
        ('Auditor','audit',         true,false,false,false,false,false,false,false,false,true)
      ) AS t(group_name, module, can_read, can_create, can_write, can_delete,
             can_approve, can_post, can_pay, can_close, can_reverse, can_export)
      WHERE t.group_name = v_name
    LOOP
      INSERT INTO public.permission_group_rules (
        permission_group_id, module, can_read, can_create, can_write, can_delete,
        can_approve, can_post, can_pay, can_close, can_reverse, can_export
      ) VALUES (
        v_group_id, v_rule.module, v_rule.can_read, v_rule.can_create, v_rule.can_write,
        v_rule.can_delete, v_rule.can_approve, v_rule.can_post, v_rule.can_pay,
        v_rule.can_close, v_rule.can_reverse, v_rule.can_export
      );
    END LOOP;
  END LOOP;
END;
$function$;

-- ---------- Backfill every existing organization ----------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_permission_groups(r.id);
  END LOOP;
END $$;

-- ---------- Module permission resolution understands MF modules ----------
CREATE OR REPLACE FUNCTION public.user_has_module_permission(_user_id uuid, _org_id uuid, _module text, _operation text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
  _mod text := CASE
    WHEN _module = 'hr'         THEN 'employees'
    WHEN _module = 'timesheets' THEN 'attendance'
    ELSE _module
  END;
  -- Granular lending modules also honour a legacy aggregate 'lending' rule.
  _lending_mods constant text[] := ARRAY[
    'clients','loan_products','applications','loans','repayments','collections'
  ];
  _fin_mods constant text[] := ARRAY['accounting','treasury'];
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('super_admin', 'owner', 'admin') THEN RETURN true; END IF;

  _base_grants := (
    CASE
      WHEN _mod = 'contacts' AND _operation = 'read' THEN _role IN ('accountant','staff','viewer','cashier','internal')
      WHEN _mod = 'contacts' AND _operation IN ('create','write','delete') THEN _role IN ('accountant','staff','internal')
      WHEN _mod IN ('financials','accounting','treasury') AND _operation IN ('read','create','write','delete') THEN _role IN ('accountant','internal')
      WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal','accountant','branch_manager','credit_officer','loan_officer','collections_officer','auditor')
      WHEN _mod IN ('team','audit','branches','reports') AND _operation = 'read' THEN _role IN ('internal','accountant','branch_manager','auditor')
      WHEN _mod = 'lending' OR _mod = ANY(_lending_mods) THEN (
        CASE _operation
          WHEN 'read'    THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer','auditor')
          WHEN 'export'  THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer','auditor')
          WHEN 'create'  THEN _role IN ('branch_manager','credit_officer','loan_officer')
          WHEN 'write'   THEN _role IN ('branch_manager','credit_officer','loan_officer','collections_officer')
          WHEN 'approve' THEN _role IN ('branch_manager','credit_officer')
          WHEN 'pay'     THEN _role IN ('branch_manager','loan_officer','collections_officer')
          WHEN 'close'   THEN _role IN ('branch_manager')
          ELSE false
        END
      )
      ELSE false
    END
  );
  IF _user_type = 'portal' THEN _base_grants := false; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND (
        pgr.module = _mod
        OR (pgr.module = 'lending'    AND _mod = ANY(_lending_mods))
        OR (pgr.module = 'financials' AND _mod = ANY(_fin_mods))
      )
      AND CASE _operation
        WHEN 'read'    THEN pgr.can_read
        WHEN 'create'  THEN pgr.can_create
        WHEN 'write'   THEN pgr.can_write
        WHEN 'delete'  THEN pgr.can_delete
        WHEN 'approve' THEN pgr.can_approve
        WHEN 'post'    THEN pgr.can_post
        WHEN 'pay'     THEN pgr.can_pay
        WHEN 'close'   THEN pgr.can_close
        WHEN 'reverse' THEN pgr.can_reverse
        WHEN 'export'  THEN pgr.can_export
        ELSE false
      END
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;