CREATE TABLE IF NOT EXISTS public.organization_statutory_identifiers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  country_code text NOT NULL,
  identifier_type text NOT NULL,
  identifier_value text NOT NULL,
  effective_from date NULL,
  effective_to date NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_statutory_identifiers_unique
  ON public.organization_statutory_identifiers
  (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
   country_code, identifier_type)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS organization_statutory_identifiers_org_idx
  ON public.organization_statutory_identifiers (organization_id, country_code);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_statutory_identifiers TO authenticated;
GRANT ALL ON public.organization_statutory_identifiers TO service_role;

ALTER TABLE public.organization_statutory_identifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can read employer statutory identifiers"
  ON public.organization_statutory_identifiers;
CREATE POLICY "Org members can read employer statutory identifiers"
  ON public.organization_statutory_identifiers FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.organization_id = organization_statutory_identifiers.organization_id
    )
  );

DROP POLICY IF EXISTS "Org admins can write employer statutory identifiers"
  ON public.organization_statutory_identifiers;
CREATE POLICY "Org admins can write employer statutory identifiers"
  ON public.organization_statutory_identifiers FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'super_admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'super_admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  );

CREATE OR REPLACE FUNCTION public.tg_org_statutory_ids_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS org_statutory_ids_touch ON public.organization_statutory_identifiers;
CREATE TRIGGER org_statutory_ids_touch
  BEFORE UPDATE ON public.organization_statutory_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.tg_org_statutory_ids_touch();


CREATE OR REPLACE FUNCTION public.payslip_header(_payslip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_run record;
  v_org record;
  v_country text;
  v_emp_ids jsonb;
  v_org_ids jsonb;
  v_required jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_present_types text[];
BEGIN
  SELECT ps.id, ps.payroll_run_id, ps.employee_id,
         e.first_name, e.last_name, e.employee_number, e.organization_id,
         e.business_id, e.statutory_country_code, e.bank_name, e.bank_branch,
         e.bank_account_number, e.department_id, e.job_position_id,
         e.country AS employee_country,
         d.name AS department_name, jp.name AS position_name
    INTO v_emp
    FROM public.payslips ps
    JOIN public.employees e ON e.id = ps.employee_id
    LEFT JOIN public.departments d ON d.id = e.department_id
    LEFT JOIN public.job_positions jp ON jp.id = e.job_position_id
   WHERE ps.id = _payslip_id;

  IF v_emp.id IS NULL THEN
    RETURN jsonb_build_object('error', 'payslip_not_found');
  END IF;

  SELECT pr.payroll_number, pr.pay_period_start, pr.pay_period_end,
         pr.payment_date, pr.currency
    INTO v_run
    FROM public.payroll_runs pr
   WHERE pr.id = v_emp.payroll_run_id;

  SELECT o.id, o.name INTO v_org
    FROM public.organizations o WHERE o.id = v_emp.organization_id;

  v_country := COALESCE(NULLIF(v_emp.statutory_country_code, ''),
                        NULLIF(v_emp.employee_country, ''));

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'identifier_type', esi.identifier_type,
             'identifier_value', esi.identifier_value,
             'country_code', esi.country_code
           ) ORDER BY esi.identifier_type
         ), '[]'::jsonb)
    INTO v_emp_ids
    FROM public.employee_statutory_identifiers esi
   WHERE esi.employee_id = v_emp.id
     AND esi.is_active
     AND COALESCE(esi.identifier_value, '') <> '';

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'identifier_type', osi.identifier_type,
             'identifier_value', osi.identifier_value,
             'country_code', osi.country_code
           ) ORDER BY osi.identifier_type
         ), '[]'::jsonb)
    INTO v_org_ids
    FROM public.organization_statutory_identifiers osi
   WHERE osi.organization_id = v_emp.organization_id
     AND osi.is_active
     AND COALESCE(osi.identifier_value, '') <> ''
     AND (osi.business_id IS NULL OR osi.business_id = v_emp.business_id)
     AND (v_country IS NULL OR osi.country_code = v_country);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'identifier_type', pr.requirement_key,
             'label', pr.label,
             'is_required', pr.is_required
           ) ORDER BY pr.sort_order, pr.requirement_key
         ), '[]'::jsonb)
    INTO v_required
    FROM public.pack_requirements pr
   WHERE pr.organization_id = v_emp.organization_id
     AND (pr.business_id = v_emp.business_id OR pr.business_id IS NULL)
     AND pr.scope = 'statutory_identifier'::pack_requirement_scope
     AND pr.is_active
     AND (v_country IS NULL OR pr.country_code IS NULL OR pr.country_code = v_country);

  SELECT array_agg(esi->>'identifier_type')
    INTO v_present_types
    FROM jsonb_array_elements(v_emp_ids) esi;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'severity', 'warning',
           'message', 'Missing required statutory identifier: ' || (r->>'label')
         )), '[]'::jsonb)
    INTO v_notes
    FROM jsonb_array_elements(v_required) r
   WHERE COALESCE((r->>'is_required')::boolean, false)
     AND NOT ((r->>'identifier_type') = ANY(COALESCE(v_present_types, ARRAY[]::text[])));

  RETURN jsonb_build_object(
    'employer', jsonb_build_object(
      'organization_id', v_emp.organization_id,
      'name', v_org.name,
      'country_code', v_country,
      'statutory_ids', v_org_ids
    ),
    'employee', jsonb_build_object(
      'id', v_emp.id,
      'name', trim(coalesce(v_emp.first_name,'') || ' ' || coalesce(v_emp.last_name,'')),
      'employee_number', v_emp.employee_number,
      'department', v_emp.department_name,
      'position', v_emp.position_name,
      'bank_name', v_emp.bank_name,
      'bank_branch', v_emp.bank_branch,
      'bank_account_masked',
        CASE WHEN v_emp.bank_account_number IS NULL OR length(v_emp.bank_account_number) <= 4
             THEN v_emp.bank_account_number
             ELSE '****' || right(v_emp.bank_account_number, 4)
        END,
      'country_code', v_country,
      'statutory_ids', v_emp_ids
    ),
    'period', jsonb_build_object(
      'payroll_number', v_run.payroll_number,
      'pay_period_start', v_run.pay_period_start,
      'pay_period_end', v_run.pay_period_end,
      'payment_date', v_run.payment_date,
      'currency', v_run.currency
    ),
    'pack', jsonb_build_object(
      'country_code', v_country,
      'required', v_required
    ),
    'notes', v_notes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payslip_header(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.payslip_header(uuid) TO authenticated, service_role;