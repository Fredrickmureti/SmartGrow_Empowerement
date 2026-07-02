
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
  v_distinct_country_count int;
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

  -- Normalise to ISO-2 upper-case so a free-text 'kenya'/'KE'/'ke' all match.
  v_country := upper(left(COALESCE(
    NULLIF(v_emp.statutory_country_code, ''),
    NULLIF(v_emp.employee_country, '')
  ), 2));

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

  -- Count distinct active employer country buckets so we can safely fall
  -- back to "the only set we have" when the employee's country doesn't
  -- match (single-country tenants, free-text country fields, etc).
  SELECT count(DISTINCT upper(left(osi.country_code, 2)))
    INTO v_distinct_country_count
    FROM public.organization_statutory_identifiers osi
   WHERE osi.organization_id = v_emp.organization_id
     AND osi.is_active
     AND COALESCE(osi.identifier_value, '') <> ''
     AND (osi.business_id IS NULL OR osi.business_id = v_emp.business_id);

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
     AND (
       v_country IS NULL
       OR upper(left(osi.country_code, 2)) = v_country
       -- Single-country tenant fallback: return what we have even if the
       -- employee's country string didn't normalise to the same ISO-2.
       OR v_distinct_country_count <= 1
     );

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
     AND (
       v_country IS NULL
       OR pr.country_code IS NULL
       OR upper(left(pr.country_code, 2)) = v_country
     );

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
END
$$;
