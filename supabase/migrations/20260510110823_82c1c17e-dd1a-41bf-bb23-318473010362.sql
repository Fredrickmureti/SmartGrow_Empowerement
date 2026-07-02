
-- 1. Columns
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS run_type TEXT NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sequence_in_period INTEGER NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_runs_run_type_check'
  ) THEN
    ALTER TABLE public.payroll_runs
      ADD CONSTRAINT payroll_runs_run_type_check
      CHECK (run_type IN ('regular','off_cycle','supplemental','bonus','commission','13th_month','termination','correction'));
  END IF;
END $$;

-- 2. Replace unique index
DROP INDEX IF EXISTS public.idx_payroll_runs_unique_period;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_unique_regular_period
  ON public.payroll_runs (organization_id, business_id, pay_period_start, pay_period_end)
  WHERE run_type = 'regular' AND status <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_payroll_runs_parent ON public.payroll_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period_type
  ON public.payroll_runs(organization_id, business_id, pay_period_start, pay_period_end, run_type);

-- 3. Auto-sequence trigger
CREATE OR REPLACE FUNCTION public.set_payroll_run_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_seq INTEGER;
BEGIN
  IF NEW.sequence_in_period IS NULL OR NEW.sequence_in_period = 1 THEN
    SELECT COALESCE(MAX(sequence_in_period), 0) + 1
      INTO next_seq
      FROM public.payroll_runs
     WHERE organization_id = NEW.organization_id
       AND COALESCE(business_id::text,'') = COALESCE(NEW.business_id::text,'')
       AND pay_period_start = NEW.pay_period_start
       AND pay_period_end = NEW.pay_period_end
       AND status <> 'deleted';
    -- only override if this would be a duplicate sequence
    IF next_seq > 1 THEN
      NEW.sequence_in_period := next_seq;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payroll_runs_sequence ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_sequence
  BEFORE INSERT ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_payroll_run_sequence();

-- 4. RPC: add employees to an existing draft run (returns count to compute)
CREATE OR REPLACE FUNCTION public.payroll_add_employees_to_run(
  p_run_id UUID,
  p_employee_ids UUID[]
)
RETURNS TABLE (
  run_id UUID,
  organization_id UUID,
  business_id UUID,
  pay_period_start DATE,
  pay_period_end DATE,
  payment_date DATE,
  added_employee_ids UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs;
  v_existing UUID[];
  v_new UUID[];
BEGIN
  SELECT * INTO v_run FROM public.payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run % not found', p_run_id USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status NOT IN ('draft','preview','calculated') THEN
    RAISE EXCEPTION 'Cannot add employees to a % run. Use an off-cycle or correction run instead.', v_run.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(employee_id), ARRAY[]::uuid[])
    INTO v_existing
    FROM public.payslips
   WHERE payroll_run_id = p_run_id;

  v_new := ARRAY(
    SELECT unnest(p_employee_ids) EXCEPT SELECT unnest(v_existing)
  );

  RETURN QUERY SELECT
    v_run.id,
    v_run.organization_id,
    v_run.business_id,
    v_run.pay_period_start,
    v_run.pay_period_end,
    v_run.payment_date,
    v_new;
END $$;

GRANT EXECUTE ON FUNCTION public.payroll_add_employees_to_run(UUID, UUID[]) TO authenticated, service_role;
