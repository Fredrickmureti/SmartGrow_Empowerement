
CREATE TABLE IF NOT EXISTS public.benefit_enrollment_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  name text NOT NULL,
  plan_year int NOT NULL,
  open_date date NOT NULL,
  close_date date NOT NULL,
  coverage_start date NOT NULL,
  coverage_end date NOT NULL,
  eligibility_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_locked boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT benefit_enrollment_windows_dates_chk CHECK (close_date >= open_date AND coverage_end >= coverage_start)
);
CREATE INDEX IF NOT EXISTS benefit_enrollment_windows_org_idx
  ON public.benefit_enrollment_windows(organization_id, plan_year);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.benefit_enrollment_windows TO authenticated;
GRANT ALL ON public.benefit_enrollment_windows TO service_role;

ALTER TABLE public.benefit_enrollment_windows ENABLE ROW LEVEL SECURITY;

CREATE POLICY benefit_enrollment_windows_org_read
  ON public.benefit_enrollment_windows FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY benefit_enrollment_windows_admin_write
  ON public.benefit_enrollment_windows FOR ALL TO authenticated
  USING (
    organization_id IN (SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid())
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'accountant'))
  )
  WITH CHECK (
    organization_id IN (SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid())
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'owner') OR public.has_role(auth.uid(), 'accountant'))
  );

CREATE TRIGGER trg_benefit_enrollment_windows_updated_at
  BEFORE UPDATE ON public.benefit_enrollment_windows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Extend employee_benefits ──
ALTER TABLE public.employee_benefits
  ADD COLUMN IF NOT EXISTS enrollment_window_id uuid REFERENCES public.benefit_enrollment_windows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS elected_employee_contribution numeric(18,2),
  ADD COLUMN IF NOT EXISTS elected_employer_contribution numeric(18,2),
  ADD COLUMN IF NOT EXISTS dependents jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS elected_at timestamptz,
  ADD COLUMN IF NOT EXISTS elected_by uuid;

CREATE INDEX IF NOT EXISTS employee_benefits_window_idx
  ON public.employee_benefits(enrollment_window_id) WHERE enrollment_window_id IS NOT NULL;

-- ── Block elections outside an open window ──
CREATE OR REPLACE FUNCTION public.block_locked_enrollment_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _w record;
BEGIN
  IF NEW.enrollment_window_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT id, is_locked, open_date, close_date INTO _w
    FROM public.benefit_enrollment_windows WHERE id = NEW.enrollment_window_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enrollment window % not found', NEW.enrollment_window_id
      USING HINT = 'benefit_enrollment_window_missing';
  END IF;
  IF _w.is_locked THEN
    RAISE EXCEPTION 'enrollment window % is locked', _w.id
      USING ERRCODE = '42501', HINT = 'benefit_enrollment_window_locked';
  END IF;
  IF CURRENT_DATE > _w.close_date OR CURRENT_DATE < _w.open_date THEN
    RAISE EXCEPTION 'enrollment window % is not currently open (% to %)', _w.id, _w.open_date, _w.close_date
      USING ERRCODE = '42501', HINT = 'benefit_enrollment_window_closed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_locked_enrollment_window ON public.employee_benefits;
CREATE TRIGGER trg_block_locked_enrollment_window
  BEFORE INSERT OR UPDATE OF enrollment_window_id, elected_employee_contribution, elected_employer_contribution, dependents
  ON public.employee_benefits
  FOR EACH ROW EXECUTE FUNCTION public.block_locked_enrollment_window();
