
-- Step 6: Submission lifecycle (B7) — join certificates to the return filing that shipped them
CREATE TABLE public.payroll_tax_certificate_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id uuid NOT NULL REFERENCES public.payroll_tax_certificates(id) ON DELETE CASCADE,
  return_run_id uuid REFERENCES public.payroll_return_runs(id) ON DELETE SET NULL,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  authority_reference text,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','accepted','rejected','retracted')),
  rejection_reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ptcs_cert ON public.payroll_tax_certificate_submissions(certificate_id);
CREATE INDEX idx_ptcs_return ON public.payroll_tax_certificate_submissions(return_run_id);
CREATE INDEX idx_ptcs_org_biz ON public.payroll_tax_certificate_submissions(organization_id, business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_tax_certificate_submissions TO authenticated;
GRANT ALL ON public.payroll_tax_certificate_submissions TO service_role;

ALTER TABLE public.payroll_tax_certificate_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ptcs_org_read ON public.payroll_tax_certificate_submissions
  FOR SELECT USING (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
  );

CREATE POLICY ptcs_org_write ON public.payroll_tax_certificate_submissions
  FOR INSERT WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  );

CREATE POLICY ptcs_org_update ON public.payroll_tax_certificate_submissions
  FOR UPDATE USING (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  ) WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
  );

CREATE POLICY ptcs_service_role_all ON public.payroll_tax_certificate_submissions
  FOR ALL USING (true) WITH CHECK (true);

-- Mirror into the lifecycle ledger so the cert audit trail stays whole
CREATE OR REPLACE FUNCTION public.payroll_log_certificate_submission_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_type := 'submitted';
  ELSIF TG_OP = 'UPDATE' AND NEW.status <> OLD.status THEN
    v_event_type := CASE NEW.status
      WHEN 'accepted' THEN 'accepted'
      WHEN 'rejected' THEN 'rejected'
      ELSE 'submitted'
    END;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.payroll_tax_certificate_events
    (certificate_id, organization_id, business_id, event_type, actor_user_id, details)
  VALUES
    (NEW.certificate_id, NEW.organization_id, NEW.business_id, v_event_type, auth.uid(),
     jsonb_build_object(
       'submission_id', NEW.id,
       'return_run_id', NEW.return_run_id,
       'authority_reference', NEW.authority_reference,
       'status', NEW.status
     ));
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ptcs_lifecycle_event
AFTER INSERT OR UPDATE ON public.payroll_tax_certificate_submissions
FOR EACH ROW EXECUTE FUNCTION public.payroll_log_certificate_submission_event();

CREATE TRIGGER update_ptcs_updated_at
BEFORE UPDATE ON public.payroll_tax_certificate_submissions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Step 7: Employer reconciliation RPC (B8) — variance between issued certificates,
-- filed returns, and actual remittance payments for one FY × template.
CREATE OR REPLACE FUNCTION public.payroll_certificate_reconciliation(
  p_organization_id uuid,
  p_business_id uuid,
  p_fiscal_year integer,
  p_template_code text
)
RETURNS TABLE (
  cert_count integer,
  cert_total_employee_tax numeric,
  cert_total_employer_tax numeric,
  return_count integer,
  return_total numeric,
  remittance_total numeric,
  variance_cert_vs_return numeric,
  variance_return_vs_remittance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH certs AS (
    SELECT
      COUNT(*)::int AS cnt,
      COALESCE(SUM(
        COALESCE(
          NULLIF(payload #>> '{totals,employee_tax}', '')::numeric,
          NULLIF(payload #>> '{totals,tax}', '')::numeric,
          NULLIF(payload #>> '{totals,total_tax}', '')::numeric,
          0
        )
      ), 0) AS emp_tax,
      COALESCE(SUM(
        COALESCE(
          NULLIF(payload #>> '{totals,employer_tax}', '')::numeric,
          NULLIF(payload #>> '{totals,employer_contributions}', '')::numeric,
          0
        )
      ), 0) AS er_tax
    FROM public.payroll_tax_certificates
    WHERE organization_id = p_organization_id
      AND business_id = p_business_id
      AND fiscal_year = p_fiscal_year
      AND template_code = p_template_code
      AND status = 'issued'
  ),
  returns AS (
    SELECT
      COUNT(*)::int AS cnt,
      COALESCE(SUM(
        COALESCE(
          NULLIF(payload #>> '{totals,total_tax}', '')::numeric,
          NULLIF(payload #>> '{totals,tax}', '')::numeric,
          0
        )
      ), 0) AS tot
    FROM public.payroll_return_runs
    WHERE organization_id = p_organization_id
      AND business_id = p_business_id
      AND template_code = p_template_code
      AND EXTRACT(YEAR FROM period_end)::int = p_fiscal_year
      AND status IN ('issued','filed','submitted','acknowledged')
  ),
  remits AS (
    SELECT COALESCE(SUM(total_amount), 0) AS tot
    FROM public.payroll_remittance_payments rp
    WHERE rp.organization_id = p_organization_id
      AND rp.business_id = p_business_id
      AND EXTRACT(YEAR FROM rp.payment_date)::int = p_fiscal_year
      AND rp.reversed_at IS NULL
  )
  SELECT
    certs.cnt,
    certs.emp_tax,
    certs.er_tax,
    returns.cnt,
    returns.tot,
    remits.tot,
    (certs.emp_tax - returns.tot) AS variance_cert_vs_return,
    (returns.tot - remits.tot) AS variance_return_vs_remittance
  FROM certs, returns, remits;
$$;

REVOKE ALL ON FUNCTION public.payroll_certificate_reconciliation(uuid, uuid, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_certificate_reconciliation(uuid, uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_certificate_reconciliation(uuid, uuid, integer, text) TO service_role;
