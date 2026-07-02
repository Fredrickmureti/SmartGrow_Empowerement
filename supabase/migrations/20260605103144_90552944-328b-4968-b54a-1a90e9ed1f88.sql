
-- =========================================================================
-- Wave 2: employments table + derived sync + readiness wiring
-- =========================================================================

-- 1. employments table
CREATE TABLE IF NOT EXISTS public.employments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE,
  employment_type TEXT NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time','part_time','contract','intern','consultant')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','on_leave','suspended','terminated')),
  termination_type TEXT
    CHECK (termination_type IS NULL OR termination_type IN
      ('voluntary','involuntary','retirement','end_of_contract','death','other')),
  termination_reason TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employments_dates_chk CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT employments_term_consistency_chk CHECK (
    (status = 'terminated' AND end_date IS NOT NULL AND termination_type IS NOT NULL)
    OR (status <> 'terminated')
  )
);

CREATE INDEX IF NOT EXISTS employments_employee_idx ON public.employments(employee_id, start_date DESC);
CREATE INDEX IF NOT EXISTS employments_business_idx ON public.employments(business_id);
CREATE INDEX IF NOT EXISTS employments_org_idx ON public.employments(organization_id);
-- at most one active primary employment per employee
CREATE UNIQUE INDEX IF NOT EXISTS employments_one_active_primary
  ON public.employments(employee_id)
  WHERE status <> 'terminated' AND is_primary = TRUE;

-- 2. Grants (REQUIRED — PostgREST does not grant by default)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employments TO authenticated;
GRANT ALL ON public.employments TO service_role;

-- 3. RLS
ALTER TABLE public.employments ENABLE ROW LEVEL SECURITY;

CREATE POLICY employments_select_v2 ON public.employments
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'hr', 'read'));

CREATE POLICY employments_insert_v2 ON public.employments
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'hr', 'write'));

CREATE POLICY employments_update_v2 ON public.employments
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'hr', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'hr', 'write'));

CREATE POLICY employments_delete_v2 ON public.employments
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'hr', 'delete'));

-- 4. updated_at trigger (reuse standard helper)
DROP TRIGGER IF EXISTS employments_set_updated_at ON public.employments;
CREATE TRIGGER employments_set_updated_at
  BEFORE UPDATE ON public.employments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Backfill from employees (idempotent)
INSERT INTO public.employments (
  organization_id, business_id, branch_id, employee_id,
  start_date, end_date, employment_type, status,
  termination_type, is_primary, created_at, updated_at
)
SELECT
  e.organization_id,
  e.business_id,
  e.branch_id,
  e.id,
  COALESCE(e.hire_date, e.created_at::date),
  CASE WHEN e.is_active = FALSE THEN COALESCE(e.termination_date, e.updated_at::date) ELSE NULL END,
  COALESCE(e.employment_type, 'full_time'),
  CASE WHEN e.is_active = FALSE THEN 'terminated' ELSE 'active' END,
  CASE WHEN e.is_active = FALSE THEN 'other' ELSE NULL END,
  TRUE,
  e.created_at,
  e.updated_at
FROM public.employees e
WHERE NOT EXISTS (SELECT 1 FROM public.employments em WHERE em.employee_id = e.id);

-- 6. Derived sync: employments → employees
CREATE OR REPLACE FUNCTION public.sync_employee_from_employments()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp_id UUID;
  v_latest RECORD;
BEGIN
  v_emp_id := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_emp_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT *
    INTO v_latest
  FROM public.employments
  WHERE employee_id = v_emp_id
  ORDER BY
    (status <> 'terminated') DESC,  -- prefer non-terminated
    is_primary DESC,
    start_date DESC,
    created_at DESC
  LIMIT 1;

  IF v_latest.id IS NULL THEN
    -- all employments deleted: mark inactive but don't touch hire_date
    UPDATE public.employees
       SET is_active = FALSE,
           updated_at = now()
     WHERE id = v_emp_id;
  ELSE
    UPDATE public.employees
       SET is_active        = (v_latest.status <> 'terminated'),
           hire_date        = v_latest.start_date,
           termination_date = CASE WHEN v_latest.status = 'terminated' THEN v_latest.end_date ELSE NULL END,
           business_id      = v_latest.business_id,
           branch_id        = COALESCE(v_latest.branch_id, branch_id),
           employment_type  = v_latest.employment_type,
           updated_at       = now()
     WHERE id = v_emp_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS employments_sync_employee ON public.employments;
CREATE TRIGGER employments_sync_employee
  AFTER INSERT OR UPDATE OR DELETE ON public.employments
  FOR EACH ROW EXECUTE FUNCTION public.sync_employee_from_employments();

-- 7. Readiness re-eval on employment changes (reuses Wave 1C quiet evaluator)
CREATE OR REPLACE FUNCTION public.trg_employments_readiness()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org UUID;
  v_emp UUID;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_emp := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_org IS NOT NULL THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, NULL::uuid, 'employee', v_emp);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS employments_readiness_eval ON public.employments;
CREATE TRIGGER employments_readiness_eval
  AFTER INSERT OR UPDATE OR DELETE ON public.employments
  FOR EACH ROW EXECUTE FUNCTION public.trg_employments_readiness();

-- 8. Wave 4 prep — leave encashment cap on leave_types (Q3 answer)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='leave_types') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='leave_types'
                     AND column_name='encashment_max_days') THEN
      ALTER TABLE public.leave_types
        ADD COLUMN encashment_max_days INTEGER DEFAULT 0
        CHECK (encashment_max_days IS NULL OR encashment_max_days >= 0);
      COMMENT ON COLUMN public.leave_types.encashment_max_days IS
        'Max days payable on termination. NULL = uncapped, 0 = disabled (default).';
    END IF;
  END IF;
END $$;
