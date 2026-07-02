
-- ============================================================
-- 1.2  employees.lifecycle_status enum + transition trigger
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.employee_lifecycle_status AS ENUM
    ('draft','active','on_leave','notice','suspended','exited','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS lifecycle_status public.employee_lifecycle_status;

-- Backfill from existing flags
UPDATE public.employees
   SET lifecycle_status = CASE
     WHEN termination_date IS NOT NULL THEN 'exited'::public.employee_lifecycle_status
     WHEN is_active = true              THEN 'active'::public.employee_lifecycle_status
     ELSE 'archived'::public.employee_lifecycle_status
   END
 WHERE lifecycle_status IS NULL;

ALTER TABLE public.employees
  ALTER COLUMN lifecycle_status SET NOT NULL,
  ALTER COLUMN lifecycle_status SET DEFAULT 'draft';

CREATE OR REPLACE FUNCTION public.enforce_employee_lifecycle_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Inserts may only land in draft or active (legacy systems push active).
    IF NEW.lifecycle_status NOT IN ('draft','active') THEN
      RAISE EXCEPTION 'employee lifecycle insert must be draft or active (got %)',
        NEW.lifecycle_status
        USING HINT = 'create employees in draft, then transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.lifecycle_status IS NOT DISTINCT FROM NEW.lifecycle_status THEN
    RETURN NEW;
  END IF;

  -- Allowed transitions
  v_allowed := CASE OLD.lifecycle_status
    WHEN 'draft'     THEN NEW.lifecycle_status IN ('active','archived')
    WHEN 'active'    THEN NEW.lifecycle_status IN ('on_leave','notice','suspended','exited')
    WHEN 'on_leave'  THEN NEW.lifecycle_status IN ('active','notice','exited')
    WHEN 'notice'    THEN NEW.lifecycle_status IN ('active','exited')
    WHEN 'suspended' THEN NEW.lifecycle_status IN ('active','exited')
    WHEN 'exited'    THEN NEW.lifecycle_status IN ('archived')
    WHEN 'archived'  THEN false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal employee lifecycle transition: % -> %',
      OLD.lifecycle_status, NEW.lifecycle_status
      USING HINT  = 'rehire must create a new employees row, never UPDATE archived back to active',
            ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_employee_lifecycle ON public.employees;
CREATE TRIGGER trg_enforce_employee_lifecycle
BEFORE INSERT OR UPDATE OF lifecycle_status ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.enforce_employee_lifecycle_transition();

CREATE INDEX IF NOT EXISTS idx_employees_lifecycle_status
  ON public.employees (organization_id, lifecycle_status);

-- ============================================================
-- 1.3  payroll_runs.scope_kind enum + validation trigger
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.payroll_run_scope_kind AS ENUM
    ('company','branch','department','employee_set','final_settlement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS scope_kind public.payroll_run_scope_kind,
  ADD COLUMN IF NOT EXISTS scope_department_id uuid REFERENCES public.departments(id);

-- Backfill from existing routing fields
UPDATE public.payroll_runs
   SET scope_kind = CASE
     WHEN COALESCE(is_final_settlement, false) THEN 'final_settlement'::public.payroll_run_scope_kind
     WHEN run_type = 'final_settlement'        THEN 'final_settlement'::public.payroll_run_scope_kind
     WHEN branch_id IS NOT NULL                THEN 'branch'::public.payroll_run_scope_kind
     ELSE                                           'company'::public.payroll_run_scope_kind
   END
 WHERE scope_kind IS NULL;

ALTER TABLE public.payroll_runs
  ALTER COLUMN scope_kind SET NOT NULL,
  ALTER COLUMN scope_kind SET DEFAULT 'company';

CREATE OR REPLACE FUNCTION public.validate_payroll_run_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  CASE NEW.scope_kind
    WHEN 'company' THEN
      IF NEW.branch_id IS NOT NULL OR NEW.scope_department_id IS NOT NULL THEN
        RAISE EXCEPTION 'company-scope payroll run must not set branch_id or scope_department_id'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'branch' THEN
      IF NEW.branch_id IS NULL THEN
        RAISE EXCEPTION 'branch-scope payroll run requires branch_id'
          USING ERRCODE = '22023';
      END IF;
      IF NEW.scope_department_id IS NOT NULL THEN
        RAISE EXCEPTION 'branch-scope payroll run must not set scope_department_id'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'department' THEN
      IF NEW.scope_department_id IS NULL THEN
        RAISE EXCEPTION 'department-scope payroll run requires scope_department_id'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'employee_set' THEN
      -- Membership is materialised in payslips; no header FK required.
      NULL;

    WHEN 'final_settlement' THEN
      IF NEW.final_settlement_employee_id IS NULL THEN
        RAISE EXCEPTION 'final_settlement scope requires final_settlement_employee_id'
          USING ERRCODE = '22023';
      END IF;
      IF NEW.run_type IS DISTINCT FROM 'final_settlement' THEN
        RAISE EXCEPTION 'final_settlement scope requires run_type = final_settlement'
          USING ERRCODE = '22023';
      END IF;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payroll_run_scope ON public.payroll_runs;
CREATE TRIGGER trg_validate_payroll_run_scope
BEFORE INSERT OR UPDATE OF scope_kind, branch_id, scope_department_id,
                           final_settlement_employee_id, run_type
ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_run_scope();

CREATE INDEX IF NOT EXISTS idx_payroll_runs_scope_kind
  ON public.payroll_runs (organization_id, scope_kind, pay_period_start DESC);

COMMENT ON COLUMN public.employees.lifecycle_status IS
  'Employee lifecycle state. Transitions enforced by trg_enforce_employee_lifecycle. Re-hire must create a new row.';
COMMENT ON COLUMN public.payroll_runs.scope_kind IS
  'Payroll run scope contract. Enforced by trg_validate_payroll_run_scope to keep routing fields coherent.';
