
-- ============================================================
-- TIER A: Project analytic ledger data-integrity fixes
-- ============================================================

-- 1. Timesheet cost-rate snapshot (freeze history)
ALTER TABLE public.timesheets
  ADD COLUMN IF NOT EXISTS cost_rate numeric;

COMMENT ON COLUMN public.timesheets.cost_rate IS
  'Snapshot of the employee cost rate at the time the timesheet was created. '
  'Used by trg_timesheet_to_cost so that historical project costs do not '
  'restate when employee salaries change.';

-- BEFORE-INSERT trigger to snapshot the rate
CREATE OR REPLACE FUNCTION public.trg_timesheet_snapshot_cost_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.cost_rate IS NULL AND NEW.project_id IS NOT NULL AND NEW.employee_id IS NOT NULL THEN
    NEW.cost_rate := public.project_employee_cost_rate(NEW.employee_id, NEW.project_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_timesheets_snapshot_cost_rate ON public.timesheets;
CREATE TRIGGER trg_timesheets_snapshot_cost_rate
  BEFORE INSERT ON public.timesheets
  FOR EACH ROW EXECUTE FUNCTION public.trg_timesheet_snapshot_cost_rate();

-- Update the cost-mirror trigger to use the snapshot when available
CREATE OR REPLACE FUNCTION public.trg_timesheet_to_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_rate numeric; v_amount numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.project_id IS NULL OR NEW.status <> 'approved' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='timesheet' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  -- Prefer the frozen snapshot; fall back to live formula for legacy rows
  v_rate   := COALESCE(NEW.cost_rate,
                       public.project_employee_cost_rate(NEW.employee_id, NEW.project_id));
  v_amount := COALESCE(NEW.hours,0) * COALESCE(v_rate,0);

  PERFORM public.upsert_project_cost(
    NEW.project_id, NEW.organization_id, NEW.business_id, NEW.task_id,
    'timesheet', NEW.id, NEW.employee_id,
    NEW.hours, v_amount, NULL, COALESCE(NEW.approved_at, NEW.date::timestamptz),
    'Timesheet labour cost'
  );
  RETURN NEW;
END;
$$;

-- ============================================================
-- 2. Stock movements → project cost ledger
-- ============================================================
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_project_id
  ON public.stock_movements(project_id)
  WHERE project_id IS NOT NULL;

COMMENT ON COLUMN public.stock_movements.project_id IS
  'Optional project tag. Outbound movements (negative quantity) with a project '
  'tag are mirrored into project_cost_entries by trg_stock_movement_to_cost.';

CREATE OR REPLACE FUNCTION public.trg_stock_movement_to_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_amount numeric;
  v_project_currency text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='stock_movement' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Only outbound (consumed) movements tagged to a project create costs
  IF NEW.project_id IS NULL OR COALESCE(NEW.quantity,0) >= 0 THEN
    DELETE FROM public.project_cost_entries
      WHERE source_type='stock_movement' AND source_id = NEW.id;
    RETURN NEW;
  END IF;

  v_amount := ABS(NEW.quantity) * COALESCE(NEW.unit_cost, 0);

  SELECT COALESCE(currency,'USD') INTO v_project_currency
    FROM public.projects WHERE id = NEW.project_id;

  PERFORM public.upsert_project_cost(
    NEW.project_id,
    NEW.organization_id,
    NEW.business_id,
    NULL,                          -- task_id
    'stock_movement',
    NEW.id,
    NULL,                          -- employee_id
    NULL,                          -- hours
    v_amount,
    v_project_currency,
    NEW.movement_date,
    'Inventory consumed on project'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movements_to_cost ON public.stock_movements;
CREATE TRIGGER trg_stock_movements_to_cost
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.trg_stock_movement_to_cost();

-- ============================================================
-- 3. Configurable employee cost rate (replace hardcoded /173)
-- ============================================================
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS cost_rate_override numeric,
  ADD COLUMN IF NOT EXISTS labor_burden_pct  numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.employees.cost_rate_override IS
  'If set, used as the per-hour cost rate verbatim (before burden). '
  'Overrides basic_salary/173 and project hourly_rate fallback.';
COMMENT ON COLUMN public.employees.labor_burden_pct IS
  'Employer-side burden (NSSF, NHIF, payroll tax, benefits) expressed as a '
  'percentage applied on top of the base cost rate. Default 0.';

CREATE OR REPLACE FUNCTION public.project_employee_cost_rate(_employee_id uuid, _project_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    COALESCE(
      (SELECT NULLIF(cost_rate_override,0) FROM public.employees WHERE id = _employee_id),
      (SELECT NULLIF(basic_salary,0) / 173.0 FROM public.employees WHERE id = _employee_id),
      (SELECT NULLIF(hourly_rate,0) FROM public.projects WHERE id = _project_id),
      0
    )
    * (1 + COALESCE(
        (SELECT labor_burden_pct FROM public.employees WHERE id = _employee_id),
        0
      ) / 100.0);
$$;
