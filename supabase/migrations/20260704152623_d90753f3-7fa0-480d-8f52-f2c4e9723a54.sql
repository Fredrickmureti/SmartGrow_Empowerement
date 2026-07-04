-- =========================================================================
-- Slice 2: Custom Deductions subsystem
-- =========================================================================

-- Enum: deduction kind
DO $$ BEGIN
  CREATE TYPE public.custom_deduction_kind AS ENUM (
    'recurring',
    'one_time',
    'voluntary',
    'involuntary'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enum: tax treatment
DO $$ BEGIN
  CREATE TYPE public.custom_deduction_tax_treatment AS ENUM (
    'pre_tax',
    'post_tax'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enum: assignment status
DO $$ BEGIN
  CREATE TYPE public.custom_deduction_status AS ENUM (
    'pending',
    'approved',
    'active',
    'suspended',
    'cancelled',
    'completed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 1. custom_deduction_types (catalog)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.custom_deduction_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  deduction_kind public.custom_deduction_kind NOT NULL,
  tax_treatment public.custom_deduction_tax_treatment NOT NULL DEFAULT 'post_tax',
  is_taxable BOOLEAN NOT NULL DEFAULT false,
  is_employer_contribution BOOLEAN NOT NULL DEFAULT false,
  computation_method TEXT NOT NULL
    CHECK (computation_method IN ('flat_amount','percentage_of_gross','percentage_of_basic','formula')),
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  gl_liability_account_id UUID REFERENCES public.accounts(id) ON DELETE RESTRICT,
  gl_expense_account_id UUID REFERENCES public.accounts(id) ON DELETE RESTRICT,
  payslip_group TEXT NOT NULL DEFAULT 'other_deductions',
  sort_order INT NOT NULL DEFAULT 100,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INT NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_deduction_types TO authenticated;
GRANT ALL ON public.custom_deduction_types TO service_role;

ALTER TABLE public.custom_deduction_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read custom deduction types"
  ON public.custom_deduction_types FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll admins manage custom deduction types (insert)"
  ON public.custom_deduction_types FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll admins manage custom deduction types (update)"
  ON public.custom_deduction_types FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll admins manage custom deduction types (delete)"
  ON public.custom_deduction_types FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_custom_deduction_types_business
  ON public.custom_deduction_types(business_id, is_active);

-- version bump + updated_at trigger
CREATE OR REPLACE FUNCTION public.custom_deduction_types_version_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.code IS DISTINCT FROM OLD.code OR
      NEW.label IS DISTINCT FROM OLD.label OR
      NEW.deduction_kind IS DISTINCT FROM OLD.deduction_kind OR
      NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR
      NEW.is_taxable IS DISTINCT FROM OLD.is_taxable OR
      NEW.is_employer_contribution IS DISTINCT FROM OLD.is_employer_contribution OR
      NEW.computation_method IS DISTINCT FROM OLD.computation_method OR
      NEW.parameters IS DISTINCT FROM OLD.parameters OR
      NEW.gl_liability_account_id IS DISTINCT FROM OLD.gl_liability_account_id OR
      NEW.gl_expense_account_id IS DISTINCT FROM OLD.gl_expense_account_id
    ) THEN
      NEW.version := OLD.version + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_custom_deduction_types_version
  BEFORE INSERT OR UPDATE ON public.custom_deduction_types
  FOR EACH ROW EXECUTE FUNCTION public.custom_deduction_types_version_trigger();

-- Guardrail: block reserved codes that belong to first-class subsystems
CREATE OR REPLACE FUNCTION public.custom_deduction_types_guardrail()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF lower(NEW.code) = ANY (ARRAY[
    'paye','shif','nhif','nssf','housing_levy','housing-levy',
    'loan','installment_loan','advance','garnishment','court_order'
  ]) THEN
    RAISE EXCEPTION 'Reserved code "%": belongs to a first-class subsystem (Loans, Advances, Garnishments, or Statutory Rules). Use the correct module.', NEW.code;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_custom_deduction_types_guardrail
  BEFORE INSERT OR UPDATE ON public.custom_deduction_types
  FOR EACH ROW EXECUTE FUNCTION public.custom_deduction_types_guardrail();

-- =========================================================================
-- 2. employee_custom_deductions (assignments)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.employee_custom_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  deduction_type_id UUID NOT NULL REFERENCES public.custom_deduction_types(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  amount_override NUMERIC(18,4),
  rate_override NUMERIC(9,6),
  status public.custom_deduction_status NOT NULL DEFAULT 'pending',
  cumulative_cap NUMERIC(18,4),
  cumulative_recovered NUMERIC(18,4) NOT NULL DEFAULT 0,
  min_net_floor NUMERIC(18,4),
  reference TEXT,
  notes TEXT,
  approver_id UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  version INT NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (amount_override IS NULL OR amount_override >= 0),
  CHECK (rate_override IS NULL OR (rate_override >= 0 AND rate_override <= 1))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_custom_deductions TO authenticated;
GRANT ALL ON public.employee_custom_deductions TO service_role;

ALTER TABLE public.employee_custom_deductions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Payroll members read employee custom deductions"
  ON public.employee_custom_deductions FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll members write employee custom deductions (insert)"
  ON public.employee_custom_deductions FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll members write employee custom deductions (update)"
  ON public.employee_custom_deductions FOR UPDATE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id))
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Payroll members write employee custom deductions (delete)"
  ON public.employee_custom_deductions FOR DELETE TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_emp_custom_deductions_employee
  ON public.employee_custom_deductions(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_custom_deductions_type
  ON public.employee_custom_deductions(deduction_type_id);
CREATE INDEX IF NOT EXISTS idx_emp_custom_deductions_business_active
  ON public.employee_custom_deductions(business_id, status)
  WHERE status IN ('approved','active');

-- version + updated_at trigger
CREATE OR REPLACE FUNCTION public.employee_custom_deductions_version_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    IF (
      NEW.deduction_type_id IS DISTINCT FROM OLD.deduction_type_id OR
      NEW.effective_from IS DISTINCT FROM OLD.effective_from OR
      NEW.effective_to IS DISTINCT FROM OLD.effective_to OR
      NEW.amount_override IS DISTINCT FROM OLD.amount_override OR
      NEW.rate_override IS DISTINCT FROM OLD.rate_override OR
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.cumulative_cap IS DISTINCT FROM OLD.cumulative_cap OR
      NEW.min_net_floor IS DISTINCT FROM OLD.min_net_floor
    ) THEN
      NEW.version := OLD.version + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_employee_custom_deductions_version
  BEFORE INSERT OR UPDATE ON public.employee_custom_deductions
  FOR EACH ROW EXECUTE FUNCTION public.employee_custom_deductions_version_trigger();

-- =========================================================================
-- 3. employee_custom_deduction_events (audit trail)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.employee_custom_deduction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES public.employee_custom_deductions(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created','approved','activated','suspended','resumed','cancelled','completed','recovered','amount_changed')),
  from_status public.custom_deduction_status,
  to_status public.custom_deduction_status,
  amount NUMERIC(18,4),
  payroll_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  notes TEXT,
  actor_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.employee_custom_deduction_events TO authenticated;
GRANT ALL ON public.employee_custom_deduction_events TO service_role;

ALTER TABLE public.employee_custom_deduction_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read custom deduction events"
  ON public.employee_custom_deduction_events FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));

CREATE POLICY "Members append custom deduction events"
  ON public.employee_custom_deduction_events FOR INSERT TO authenticated
  WITH CHECK (public.user_has_business_access(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_custom_deduction_events_assignment
  ON public.employee_custom_deduction_events(assignment_id, created_at DESC);

-- Lifecycle event trigger on assignment changes
CREATE OR REPLACE FUNCTION public.employee_custom_deductions_event_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.employee_custom_deduction_events(
      assignment_id, business_id, event_type, to_status, actor_id
    ) VALUES (NEW.id, NEW.business_id, 'created', NEW.status, NEW.created_by);
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.employee_custom_deduction_events(
      assignment_id, business_id, event_type, from_status, to_status, actor_id
    ) VALUES (
      NEW.id, NEW.business_id,
      CASE NEW.status
        WHEN 'approved'  THEN 'approved'
        WHEN 'active'    THEN 'activated'
        WHEN 'suspended' THEN 'suspended'
        WHEN 'cancelled' THEN 'cancelled'
        WHEN 'completed' THEN 'completed'
        ELSE 'amount_changed'
      END,
      OLD.status, NEW.status, auth.uid()
    );
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_employee_custom_deductions_events
  AFTER INSERT OR UPDATE ON public.employee_custom_deductions
  FOR EACH ROW EXECUTE FUNCTION public.employee_custom_deductions_event_trigger();

-- =========================================================================
-- 4. Realtime publication
-- =========================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.employee_custom_deduction_events;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;

-- =========================================================================
-- 5. Payslip source enum extension (if enum) OR just document new source value
--    payslip_lines.source is text (per audit); no enum change needed.
-- =========================================================================
COMMENT ON TABLE public.custom_deduction_types IS
  'Slice 2: workspace-defined ad-hoc deductions (gym, SACCO, parking). NOT for loans/advances/garnishments/statutory — those have first-class modules.';
COMMENT ON TABLE public.employee_custom_deductions IS
  'Slice 2: per-employee assignment of a custom deduction type with effective dates and lifecycle.';
COMMENT ON COLUMN public.employee_custom_deductions.cumulative_recovered IS
  'Running total maintained by compute-payroll; drives auto-completion when cumulative_cap is reached.';