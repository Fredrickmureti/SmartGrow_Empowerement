
-- =====================================================================
-- HR Audit — Wave 1 schema (covers C2, C4, C5, C6, C7, H1, M2)
-- =====================================================================

-- ---------------------------------------------------------------------
-- C4 — Onboarding default flag (drives auto-instantiate on hire)
-- ---------------------------------------------------------------------
ALTER TABLE public.onboarding_templates
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- Ensure at most one default template per (org, business, template_type).
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_templates_one_default_per_type
  ON public.onboarding_templates (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), template_type)
  WHERE is_default;

-- ---------------------------------------------------------------------
-- C5 — Final-settlement / off-cycle payroll-run flags
-- ---------------------------------------------------------------------
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS is_final_settlement boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS final_settlement_employee_id uuid NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_type text NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS group_id uuid NULL;

-- Validation trigger (avoid CHECK with non-immutable refs)
CREATE OR REPLACE FUNCTION public.validate_payroll_run_type()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_type NOT IN ('regular','off_cycle','final_settlement','group_child') THEN
    RAISE EXCEPTION 'invalid run_type: %', NEW.run_type;
  END IF;
  IF NEW.is_final_settlement AND NEW.final_settlement_employee_id IS NULL THEN
    RAISE EXCEPTION 'final_settlement_employee_id required when is_final_settlement=true';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_payroll_run_type ON public.payroll_runs;
CREATE TRIGGER trg_validate_payroll_run_type
  BEFORE INSERT OR UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_run_type();

-- ---------------------------------------------------------------------
-- H1 — Master / group payroll runs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payroll_run_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  totals_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_run_groups TO authenticated;
GRANT ALL ON public.payroll_run_groups TO service_role;
ALTER TABLE public.payroll_run_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_run_groups_select ON public.payroll_run_groups
  FOR SELECT TO authenticated
  USING (public.has_payroll_access(auth.uid(), organization_id));
CREATE POLICY payroll_run_groups_manage ON public.payroll_run_groups
  FOR ALL TO authenticated
  USING (public.has_payroll_access(auth.uid(), organization_id))
  WITH CHECK (public.has_payroll_access(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS trg_payroll_run_groups_updated_at ON public.payroll_run_groups;
CREATE TRIGGER trg_payroll_run_groups_updated_at
  BEFORE UPDATE ON public.payroll_run_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Wire payroll_runs.group_id to payroll_run_groups
ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS payroll_runs_group_id_fkey;
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT payroll_runs_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES public.payroll_run_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payroll_runs_group_id_idx ON public.payroll_runs(group_id) WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- C7 — Asset assignment to employees
-- ---------------------------------------------------------------------
ALTER TABLE public.fixed_assets
  ADD COLUMN IF NOT EXISTS assigned_to_employee_id uuid NULL REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS assignment_notes text NULL;

CREATE INDEX IF NOT EXISTS fixed_assets_assigned_employee_idx
  ON public.fixed_assets(assigned_to_employee_id)
  WHERE assigned_to_employee_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- C2 — Exit clearance + items
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_exit_clearance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  initiated_by uuid NULL,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  last_working_day date NOT NULL,
  exit_type text NOT NULL DEFAULT 'resignation',
  reason text NULL,
  status text NOT NULL DEFAULT 'in_progress',
  final_pay_run_id uuid NULL REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  certificate_url text NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_exit_clearance_emp_idx
  ON public.employee_exit_clearance(employee_id);
CREATE INDEX IF NOT EXISTS employee_exit_clearance_org_status_idx
  ON public.employee_exit_clearance(organization_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_exit_clearance TO authenticated;
GRANT ALL ON public.employee_exit_clearance TO service_role;
ALTER TABLE public.employee_exit_clearance ENABLE ROW LEVEL SECURITY;

CREATE POLICY exit_clearance_select ON public.employee_exit_clearance
  FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr'::text, 'read'::text)
    OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );
CREATE POLICY exit_clearance_manage ON public.employee_exit_clearance
  FOR ALL TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'hr'::text, 'write'::text))
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'hr'::text, 'write'::text));

DROP TRIGGER IF EXISTS trg_exit_clearance_updated_at ON public.employee_exit_clearance;
CREATE TRIGGER trg_exit_clearance_updated_at
  BEFORE UPDATE ON public.employee_exit_clearance
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.employee_exit_clearance_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clearance_id uuid NOT NULL REFERENCES public.employee_exit_clearance(id) ON DELETE CASCADE,
  department text NOT NULL,
  task text NOT NULL,
  assignee_user_id uuid NULL,
  status text NOT NULL DEFAULT 'pending',
  signed_by uuid NULL,
  signed_at timestamptz NULL,
  notes text NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_blocking boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exit_clearance_items_clearance_idx
  ON public.employee_exit_clearance_items(clearance_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_exit_clearance_items TO authenticated;
GRANT ALL ON public.employee_exit_clearance_items TO service_role;
ALTER TABLE public.employee_exit_clearance_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY exit_clearance_items_select ON public.employee_exit_clearance_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.employee_exit_clearance c
      WHERE c.id = clearance_id
        AND (
          public.user_has_module_permission(auth.uid(), c.organization_id, 'hr'::text, 'read'::text)
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = c.employee_id AND e.user_id = auth.uid())
        )
    )
  );
CREATE POLICY exit_clearance_items_manage ON public.employee_exit_clearance_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.employee_exit_clearance c
      WHERE c.id = clearance_id
        AND public.user_has_module_permission(auth.uid(), c.organization_id, 'hr'::text, 'write'::text)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.employee_exit_clearance c
      WHERE c.id = clearance_id
        AND public.user_has_module_permission(auth.uid(), c.organization_id, 'hr'::text, 'write'::text)
    )
  );

DROP TRIGGER IF EXISTS trg_exit_clearance_items_updated_at ON public.employee_exit_clearance_items;
CREATE TRIGGER trg_exit_clearance_items_updated_at
  BEFORE UPDATE ON public.employee_exit_clearance_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- C6 — Employees can read their own benefit enrollments
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS employee_benefits_select_own ON public.employee_benefits;
CREATE POLICY employee_benefits_select_own ON public.employee_benefits
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );

-- Same for benefit plan reference data (so payslip can render plan name)
DROP POLICY IF EXISTS benefit_plans_select_for_enrolled ON public.benefit_plans;
CREATE POLICY benefit_plans_select_for_enrolled ON public.benefit_plans
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.employee_benefits eb
      JOIN public.employees e ON e.id = eb.employee_id
      WHERE eb.benefit_plan_id = benefit_plans.id
        AND e.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- M2 — Compensation history (audit trail for pay changes)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_compensation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  basic_salary numeric(18,2) NOT NULL,
  allowances_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency_code text NULL,
  change_type text NOT NULL DEFAULT 'adjustment',
  reason text NULL,
  approved_by uuid NULL,
  source_contract_id uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS emp_comp_history_employee_idx
  ON public.employee_compensation_history(employee_id, effective_date DESC);

GRANT SELECT, INSERT ON public.employee_compensation_history TO authenticated;
GRANT ALL ON public.employee_compensation_history TO service_role;
ALTER TABLE public.employee_compensation_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY emp_comp_history_select ON public.employee_compensation_history
  FOR SELECT TO authenticated
  USING (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr'::text, 'read'::text)
    OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );
CREATE POLICY emp_comp_history_insert ON public.employee_compensation_history
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'hr'::text, 'write'::text)
  );
