-- W1: Auto-fill org/business on filing-event inserts from the parent run.
CREATE OR REPLACE FUNCTION public.payroll_return_filing_events_fill_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
BEGIN
  SELECT organization_id, business_id
    INTO v_org, v_biz
    FROM public.payroll_return_runs
   WHERE id = NEW.run_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'payroll_return_filing_events.run_id % not found', NEW.run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.organization_id := v_org;
  NEW.business_id := v_biz;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_return_filing_events_fill_scope
  ON public.payroll_return_filing_events;
CREATE TRIGGER trg_payroll_return_filing_events_fill_scope
  BEFORE INSERT ON public.payroll_return_filing_events
  FOR EACH ROW EXECUTE FUNCTION public.payroll_return_filing_events_fill_scope();

-- W1: State-machine validator.
CREATE OR REPLACE FUNCTION public.payroll_return_assert_transition(
  p_from text,
  p_to text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF (p_from, p_to) NOT IN (
    ('draft','generated'),
    ('generated','submitted_awaiting_ack'),
    ('generated','filed'),
    ('generated','superseded'),
    ('submitted_awaiting_ack','acknowledged'),
    ('submitted_awaiting_ack','rejected'),
    ('submitted_awaiting_ack','filed'),
    ('acknowledged','filed'),
    ('rejected','generated'),
    ('rejected','submitted_awaiting_ack'),
    ('filed','superseded'),
    ('acknowledged','superseded'),
    ('rejected','superseded')
  ) THEN
    RAISE EXCEPTION 'invalid return state transition: % -> %', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_return_assert_transition(text, text)
  TO authenticated, service_role;

-- W7: Employer-side certificates support.
ALTER TABLE public.payroll_tax_certificates
  ALTER COLUMN employee_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payroll_tax_certificates' AND column_name='subject'
  ) THEN
    ALTER TABLE public.payroll_tax_certificates
      ADD COLUMN subject text NOT NULL DEFAULT 'employee'
      CHECK (subject IN ('employee','employer'));
  END IF;
END $$;

UPDATE public.payroll_tax_certificates
   SET subject = 'employee'
 WHERE subject IS DISTINCT FROM 'employee'
   AND employee_id IS NOT NULL;

ALTER TABLE public.payroll_tax_certificates
  DROP CONSTRAINT IF EXISTS payroll_tax_certificates_subject_employee_id_check;
ALTER TABLE public.payroll_tax_certificates
  ADD CONSTRAINT payroll_tax_certificates_subject_employee_id_check
  CHECK (
    (subject = 'employee' AND employee_id IS NOT NULL)
    OR (subject = 'employer' AND employee_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS payroll_tax_certificates_emp_issued_uq
  ON public.payroll_tax_certificates (organization_id, business_id, template_code, employee_id, fiscal_year)
  WHERE status = 'issued' AND subject = 'employee';

CREATE UNIQUE INDEX IF NOT EXISTS payroll_tax_certificates_employer_issued_uq
  ON public.payroll_tax_certificates (organization_id, business_id, template_code, fiscal_year)
  WHERE status = 'issued' AND subject = 'employer';

COMMENT ON COLUMN public.payroll_tax_certificates.subject IS
  'employee = per-person certificate (P9, W-2, Form 16). employer = aggregate filing (P10A, W-3, 24Q).';
