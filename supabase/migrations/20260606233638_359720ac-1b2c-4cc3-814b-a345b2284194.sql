
-- ============================================================
-- H-1: employee_position_history (effective-dated org history)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.employee_position_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_from timestamptz NOT NULL DEFAULT now(),
  department_id uuid,
  branch_id uuid,
  job_position_id uuid,
  manager_id uuid,
  employment_type text,
  change_reason text,
  changed_by uuid,
  prev_department_id uuid,
  prev_branch_id uuid,
  prev_job_position_id uuid,
  prev_manager_id uuid,
  prev_employment_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.employee_position_history TO authenticated;
GRANT ALL ON public.employee_position_history TO service_role;

ALTER TABLE public.employee_position_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eph_select_org"
  ON public.employee_position_history
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid()));

CREATE POLICY "eph_service_all"
  ON public.employee_position_history
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_eph_employee_effective
  ON public.employee_position_history(employee_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_eph_org
  ON public.employee_position_history(organization_id, effective_from DESC);

CREATE OR REPLACE FUNCTION public.fn_record_employee_position_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.employee_position_history(
      organization_id, employee_id, effective_from,
      department_id, branch_id, job_position_id, manager_id, employment_type,
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      'initial', auth.uid()
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (
       NEW.department_id   IS DISTINCT FROM OLD.department_id   OR
       NEW.branch_id       IS DISTINCT FROM OLD.branch_id       OR
       NEW.job_position_id IS DISTINCT FROM OLD.job_position_id OR
       NEW.manager_id      IS DISTINCT FROM OLD.manager_id      OR
       NEW.employment_type IS DISTINCT FROM OLD.employment_type
     ) THEN
    INSERT INTO public.employee_position_history(
      organization_id, employee_id, effective_from,
      department_id, branch_id, job_position_id, manager_id, employment_type,
      prev_department_id, prev_branch_id, prev_job_position_id, prev_manager_id, prev_employment_type,
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      OLD.department_id, OLD.branch_id, OLD.job_position_id, OLD.manager_id, OLD.employment_type,
      'update', auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_position_history ON public.employees;
CREATE TRIGGER trg_employee_position_history
  AFTER INSERT OR UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.fn_record_employee_position_change();

-- Backfill: one baseline row per existing employee (only if no history exists yet)
INSERT INTO public.employee_position_history(
  organization_id, employee_id, effective_from,
  department_id, branch_id, job_position_id, manager_id, employment_type, change_reason
)
SELECT e.organization_id, e.id, COALESCE(e.created_at, now()),
       e.department_id, e.branch_id, e.job_position_id, e.manager_id, e.employment_type,
       'backfill'
FROM public.employees e
WHERE NOT EXISTS (
  SELECT 1 FROM public.employee_position_history h WHERE h.employee_id = e.id
);

-- ============================================================
-- M-3: pin localization pack + version on payroll_runs
-- ============================================================
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS localization_pack_id uuid,
  ADD COLUMN IF NOT EXISTS localization_pack_version text,
  ADD COLUMN IF NOT EXISTS localization_pack_pinned_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_pin_localization_pack_on_payroll_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pack_id uuid;
  v_pack_version text;
BEGIN
  -- Only pin when transitioning into a compute/lock state and not already pinned
  IF NEW.status IN ('computing','computed','approved','paid','locked') AND NEW.localization_pack_id IS NULL THEN
    SELECT ilp.pack_id, ilp.pack_version
      INTO v_pack_id, v_pack_version
    FROM public.installed_localization_packs ilp
    WHERE ilp.organization_id = NEW.organization_id
      AND ilp.status = 'active'
    ORDER BY ilp.installed_at DESC
    LIMIT 1;

    IF v_pack_id IS NOT NULL THEN
      NEW.localization_pack_id := v_pack_id;
      NEW.localization_pack_version := v_pack_version;
      NEW.localization_pack_pinned_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pin_localization_pack ON public.payroll_runs;
CREATE TRIGGER trg_pin_localization_pack
  BEFORE INSERT OR UPDATE OF status ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.fn_pin_localization_pack_on_payroll_run();

CREATE INDEX IF NOT EXISTS idx_payroll_runs_pack
  ON public.payroll_runs(localization_pack_id, localization_pack_version);

-- ============================================================
-- M-2: leave_types.unit (full_day | half_day | hour)
-- ============================================================
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'full_day';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leave_types_unit_check') THEN
    ALTER TABLE public.leave_types
      ADD CONSTRAINT leave_types_unit_check
      CHECK (unit IN ('full_day','half_day','hour'));
  END IF;
END$$;

-- Mirror existing allow_half_day flag into unit for backward compatibility
UPDATE public.leave_types
   SET unit = 'half_day'
 WHERE allow_half_day = true AND unit = 'full_day';

-- ============================================================
-- M-1: Negative net-pay guard on payslips
-- ============================================================
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS allow_negative_net boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS negative_net_reason text;

CREATE OR REPLACE FUNCTION public.fn_guard_negative_net_pay()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.net_pay IS NOT NULL AND NEW.net_pay < 0 AND COALESCE(NEW.allow_negative_net, false) = false THEN
    RAISE EXCEPTION 'PAYSLIP_NEGATIVE_NET_PAY: net_pay=% requires allow_negative_net=true with a reason', NEW.net_pay
      USING HINT = 'PAYSLIP_NEGATIVE_NET_PAY';
  END IF;
  IF NEW.net_pay IS NOT NULL AND NEW.net_pay < 0
     AND NEW.allow_negative_net = true
     AND (NEW.negative_net_reason IS NULL OR length(btrim(NEW.negative_net_reason)) = 0) THEN
    RAISE EXCEPTION 'PAYSLIP_NEGATIVE_NET_PAY: negative_net_reason required when allow_negative_net=true'
      USING HINT = 'PAYSLIP_NEGATIVE_NET_PAY';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payslip_negative_net_guard ON public.payslips;
CREATE TRIGGER trg_payslip_negative_net_guard
  BEFORE INSERT OR UPDATE OF net_pay, allow_negative_net, negative_net_reason ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_negative_net_pay();
