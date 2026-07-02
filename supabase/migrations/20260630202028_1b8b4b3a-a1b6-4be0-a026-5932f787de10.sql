
-- Step 1: lifecycle event ledger
CREATE TABLE public.payroll_tax_certificate_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id UUID NOT NULL REFERENCES public.payroll_tax_certificates(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('generated','superseded','downloaded','submitted','accepted','rejected','marked_stale','reissued')),
  actor_user_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ptce_cert ON public.payroll_tax_certificate_events(certificate_id, created_at DESC);
CREATE INDEX idx_ptce_org ON public.payroll_tax_certificate_events(organization_id, business_id, created_at DESC);

GRANT SELECT, INSERT ON public.payroll_tax_certificate_events TO authenticated;
GRANT ALL ON public.payroll_tax_certificate_events TO service_role;
ALTER TABLE public.payroll_tax_certificate_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ptce_org_read ON public.payroll_tax_certificate_events FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read'));
CREATE POLICY ptce_employee_self_read ON public.payroll_tax_certificate_events FOR SELECT TO authenticated
  USING (certificate_id IN (
    SELECT c.id FROM public.payroll_tax_certificates c
    JOIN public.employees e ON e.id = c.employee_id
    WHERE e.user_id = auth.uid()
  ));
CREATE POLICY ptce_service_role_all ON public.payroll_tax_certificate_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Trigger: emit generated / superseded events automatically.
CREATE OR REPLACE FUNCTION public.payroll_tax_certificate_emit_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.payroll_tax_certificate_events (certificate_id, organization_id, business_id, event_type, actor_user_id, details)
    VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'generated', NEW.generated_by,
      jsonb_build_object('serial_number', NEW.serial_number, 'template_code', NEW.template_code, 'fiscal_year', NEW.fiscal_year, 'batch_id', NEW.batch_id));
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'superseded' AND OLD.status <> 'superseded' THEN
    INSERT INTO public.payroll_tax_certificate_events (certificate_id, organization_id, business_id, event_type, actor_user_id, details)
    VALUES (NEW.id, NEW.organization_id, NEW.business_id, 'superseded', NULL,
      jsonb_build_object('superseded_by', NEW.superseded_by, 'serial_number', NEW.serial_number));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ptc_emit_event ON public.payroll_tax_certificates;
CREATE TRIGGER trg_ptc_emit_event
AFTER INSERT OR UPDATE OF status ON public.payroll_tax_certificates
FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_certificate_emit_event();

-- Step 2: provenance + staleness
ALTER TABLE public.payroll_tax_certificates
  ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_reason TEXT,
  ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ptc_stale ON public.payroll_tax_certificates(organization_id, business_id, fiscal_year) WHERE stale = true;

-- Detects issued certificates whose underlying payroll surface has moved
-- (run reversed, payslip corrected, retro adjustment) since issuance.
-- Compares snapshot provenance.max_payroll_updated_at with current MAX of
-- payroll_runs.updated_at + payslips.updated_at for the FY.
CREATE OR REPLACE FUNCTION public.payroll_mark_stale_certificates(
  p_org UUID, p_business UUID, p_fiscal_year INTEGER DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  WITH current_state AS (
    SELECT
      c.id,
      c.organization_id,
      c.business_id,
      c.fiscal_year,
      COALESCE((c.provenance->>'max_payroll_updated_at')::timestamptz, 'epoch'::timestamptz) AS snapshot_ts,
      GREATEST(
        COALESCE((SELECT MAX(r.updated_at) FROM payroll_runs r
                  WHERE r.organization_id = c.organization_id
                    AND r.business_id = c.business_id
                    AND EXTRACT(YEAR FROM r.pay_period_end)::int = c.fiscal_year), 'epoch'::timestamptz),
        COALESCE((SELECT MAX(p.updated_at) FROM payslips p
                  JOIN payroll_runs r ON r.id = p.payroll_run_id
                  WHERE p.organization_id = c.organization_id
                    AND p.business_id = c.business_id
                    AND p.employee_id = c.employee_id
                    AND EXTRACT(YEAR FROM r.pay_period_end)::int = c.fiscal_year), 'epoch'::timestamptz)
      ) AS current_ts
    FROM payroll_tax_certificates c
    WHERE c.organization_id = p_org
      AND c.business_id = p_business
      AND c.status = 'issued'
      AND c.stale = false
      AND (p_fiscal_year IS NULL OR c.fiscal_year = p_fiscal_year)
  ),
  updated AS (
    UPDATE payroll_tax_certificates c
       SET stale = true,
           stale_reason = 'payroll_surface_changed',
           stale_at = now()
      FROM current_state cs
     WHERE c.id = cs.id
       AND cs.current_ts > cs.snapshot_ts
    RETURNING c.id, c.organization_id, c.business_id
  ),
  ev AS (
    INSERT INTO payroll_tax_certificate_events (certificate_id, organization_id, business_id, event_type, details)
    SELECT id, organization_id, business_id, 'marked_stale',
           jsonb_build_object('reason', 'payroll_surface_changed', 'detected_at', now())
      FROM updated
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM ev;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.payroll_mark_stale_certificates(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_mark_stale_certificates(UUID, UUID, INTEGER) TO authenticated, service_role;

-- Step 3: canonical view for active installed pack (eliminates installed vs active drift)
CREATE OR REPLACE VIEW public.v_org_active_localization_pack AS
SELECT DISTINCT ON (organization_id, business_id)
  organization_id,
  business_id,
  pack_id,
  pack_version,
  installed_at,
  status
FROM public.installed_localization_packs
WHERE status IN ('installed', 'active')
ORDER BY organization_id, business_id, installed_at DESC NULLS LAST;

GRANT SELECT ON public.v_org_active_localization_pack TO authenticated, service_role;
