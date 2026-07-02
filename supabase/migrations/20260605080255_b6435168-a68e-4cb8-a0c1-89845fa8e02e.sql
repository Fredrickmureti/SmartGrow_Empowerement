
-- ============================================================
-- Employee ↔ Contract date integrity invariants
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_employee_contract_dates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp   RECORD;
  v_overlap_id uuid;
BEGIN
  -- end >= start
  IF NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'Contract end date (%) cannot be before start date (%).',
      NEW.end_date, NEW.start_date
      USING ERRCODE = 'P0001', HINT = 'contract_end_before_start';
  END IF;

  SELECT hire_date, termination_date
    INTO v_emp
    FROM public.employees
   WHERE id = NEW.employee_id;

  IF NOT FOUND THEN
    RETURN NEW; -- FK will reject; nothing more to validate
  END IF;

  IF v_emp.hire_date IS NOT NULL AND NEW.start_date < v_emp.hire_date THEN
    RAISE EXCEPTION 'Contract start date (%) cannot be before the employee''s hire date (%).',
      NEW.start_date, v_emp.hire_date
      USING ERRCODE = 'P0001', HINT = 'contract_start_before_hire_date';
  END IF;

  IF v_emp.termination_date IS NOT NULL
     AND NEW.end_date IS NOT NULL
     AND NEW.end_date > v_emp.termination_date THEN
    RAISE EXCEPTION 'Contract end date (%) cannot be after the employee''s termination date (%).',
      NEW.end_date, v_emp.termination_date
      USING ERRCODE = 'P0001', HINT = 'contract_end_after_termination_date';
  END IF;

  -- Overlap check: only enforced for new/running statuses
  IF NEW.status IN ('new','running') THEN
    SELECT id INTO v_overlap_id
      FROM public.employee_contracts
     WHERE employee_id = NEW.employee_id
       AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND status IN ('new','running')
       AND daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]')
           && daterange(NEW.start_date, COALESCE(NEW.end_date, 'infinity'::date), '[]')
     LIMIT 1;

    IF v_overlap_id IS NOT NULL THEN
      RAISE EXCEPTION 'This contract overlaps an existing active/new contract (%) for the same employee.',
        v_overlap_id
        USING ERRCODE = 'P0001', HINT = 'contract_overlaps_existing';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_employee_contract_dates ON public.employee_contracts;
CREATE TRIGGER trg_validate_employee_contract_dates
  BEFORE INSERT OR UPDATE ON public.employee_contracts
  FOR EACH ROW EXECUTE FUNCTION public.validate_employee_contract_dates();

-- Symmetric guard on employees: prevent moving hire_date past existing contract start,
-- or termination_date before existing contract end.
CREATE OR REPLACE FUNCTION public.validate_employee_dates_vs_contracts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_start date;
  v_max_end   date;
BEGIN
  IF NEW.hire_date IS DISTINCT FROM OLD.hire_date
     OR NEW.termination_date IS DISTINCT FROM OLD.termination_date THEN

    SELECT MIN(start_date), MAX(end_date)
      INTO v_min_start, v_max_end
      FROM public.employee_contracts
     WHERE employee_id = NEW.id
       AND status IN ('new','running');

    IF NEW.hire_date IS NOT NULL
       AND v_min_start IS NOT NULL
       AND NEW.hire_date > v_min_start THEN
      RAISE EXCEPTION 'Hire date (%) cannot be after the earliest active contract start (%).',
        NEW.hire_date, v_min_start
        USING ERRCODE = 'P0001', HINT = 'hire_date_after_contract_start';
    END IF;

    IF NEW.termination_date IS NOT NULL
       AND v_max_end IS NOT NULL
       AND NEW.termination_date < v_max_end THEN
      RAISE EXCEPTION 'Termination date (%) cannot be before the latest active contract end (%).',
        NEW.termination_date, v_max_end
        USING ERRCODE = 'P0001', HINT = 'termination_date_before_contract_end';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_employee_dates_vs_contracts ON public.employees;
CREATE TRIGGER trg_validate_employee_dates_vs_contracts
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.validate_employee_dates_vs_contracts();

-- Read-only view of pre-existing violations so operators can reconcile.
CREATE OR REPLACE VIEW public.employee_contract_date_violations AS
SELECT
  ec.id                AS contract_id,
  ec.organization_id,
  ec.business_id,
  ec.employee_id,
  ec.contract_reference,
  ec.start_date        AS contract_start_date,
  ec.end_date          AS contract_end_date,
  ec.status,
  e.hire_date,
  e.termination_date,
  CASE
    WHEN ec.end_date IS NOT NULL AND ec.end_date < ec.start_date
      THEN 'contract_end_before_start'
    WHEN e.hire_date IS NOT NULL AND ec.start_date < e.hire_date
      THEN 'contract_start_before_hire_date'
    WHEN e.termination_date IS NOT NULL
         AND ec.end_date IS NOT NULL
         AND ec.end_date > e.termination_date
      THEN 'contract_end_after_termination_date'
  END AS violation
FROM public.employee_contracts ec
JOIN public.employees e ON e.id = ec.employee_id
WHERE (ec.end_date IS NOT NULL AND ec.end_date < ec.start_date)
   OR (e.hire_date IS NOT NULL AND ec.start_date < e.hire_date)
   OR (e.termination_date IS NOT NULL
       AND ec.end_date IS NOT NULL
       AND ec.end_date > e.termination_date);

GRANT SELECT ON public.employee_contract_date_violations TO authenticated;
GRANT ALL    ON public.employee_contract_date_violations TO service_role;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.employee_contract_date_violations;
  IF v_count > 0 THEN
    RAISE NOTICE 'employee_contract_date_violations: % pre-existing row(s) violate the new date invariants. Review via SELECT * FROM public.employee_contract_date_violations.', v_count;
  END IF;
END $$;
