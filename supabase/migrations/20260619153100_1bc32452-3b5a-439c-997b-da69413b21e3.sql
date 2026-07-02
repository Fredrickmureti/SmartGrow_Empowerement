-- Enums
DO $$ BEGIN
  CREATE TYPE public.employee_advance_status AS ENUM ('requested','approved','disbursed','recovering','recovered','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.advance_recovery_method AS ENUM ('lump_sum','installments');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.advance_repayment_status AS ENUM ('scheduled','partial','recovered','skipped','written_off');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. employee_advances
CREATE TABLE IF NOT EXISTS public.employee_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'USD',
  advance_date date NOT NULL DEFAULT CURRENT_DATE,
  reason text,
  status public.employee_advance_status NOT NULL DEFAULT 'requested',
  recovery_method public.advance_recovery_method NOT NULL DEFAULT 'lump_sum',
  installment_count integer NOT NULL DEFAULT 1 CHECK (installment_count >= 1),
  installment_amount numeric(18,2),
  min_net_floor numeric(18,2),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  disbursed_at timestamptz,
  recovered_amount numeric(18,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_advances TO authenticated;
GRANT ALL ON public.employee_advances TO service_role;

ALTER TABLE public.employee_advances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can view advances"
  ON public.employee_advances FOR SELECT TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.user_id = auth.uid())
  );

CREATE POLICY "HR/payroll can insert advances"
  ON public.employee_advances FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "HR/payroll can update advances"
  ON public.employee_advances FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "HR/payroll can delete advances"
  ON public.employee_advances FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_employee_advances_business_status
  ON public.employee_advances(business_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_advances_employee
  ON public.employee_advances(employee_id);

CREATE TRIGGER trg_employee_advances_updated_at
  BEFORE UPDATE ON public.employee_advances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. advance_repayment_schedule
CREATE TABLE IF NOT EXISTS public.advance_repayment_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.employee_advances(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  due_period_start date NOT NULL,
  due_period_end date NOT NULL,
  scheduled_amount numeric(18,2) NOT NULL CHECK (scheduled_amount >= 0),
  recovered_amount numeric(18,2) NOT NULL DEFAULT 0,
  payroll_run_id uuid REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  payslip_id uuid REFERENCES public.payslips(id) ON DELETE SET NULL,
  status public.advance_repayment_status NOT NULL DEFAULT 'scheduled',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_period_end >= due_period_start)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.advance_repayment_schedule TO authenticated;
GRANT ALL ON public.advance_repayment_schedule TO service_role;

ALTER TABLE public.advance_repayment_schedule ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can view repayments"
  ON public.advance_repayment_schedule FOR SELECT TO authenticated
  USING (
    public.user_has_business_access(auth.uid(), business_id)
    OR EXISTS (
      SELECT 1 FROM public.employee_advances a
      JOIN public.employees e ON e.id = a.employee_id
      WHERE a.id = advance_id AND e.user_id = auth.uid()
    )
  );

CREATE POLICY "HR/payroll can insert repayments"
  ON public.advance_repayment_schedule FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "HR/payroll can update repayments"
  ON public.advance_repayment_schedule FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "HR/payroll can delete repayments"
  ON public.advance_repayment_schedule FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_advance_repayment_schedule_advance
  ON public.advance_repayment_schedule(advance_id);
CREATE INDEX IF NOT EXISTS idx_advance_repayment_schedule_business_status
  ON public.advance_repayment_schedule(business_id, status);

CREATE TRIGGER trg_advance_repayment_schedule_updated_at
  BEFORE UPDATE ON public.advance_repayment_schedule
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();