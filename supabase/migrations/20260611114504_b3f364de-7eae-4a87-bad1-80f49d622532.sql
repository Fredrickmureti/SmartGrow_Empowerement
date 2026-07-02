
CREATE OR REPLACE FUNCTION public.employee_payroll_readiness(p_employee_id uuid)
RETURNS TABLE(
  employee_id uuid,
  has_contract boolean,
  has_salary boolean,
  has_schedule boolean,
  has_bank boolean,
  required_identifier_keys text[],
  present_identifier_keys text[],
  missing_identifier_keys text[],
  is_ready boolean,
  blockers text[]
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_today date := CURRENT_DATE;
  v_contract_id uuid;
  v_wage numeric;
  v_working_schedule text;
  v_salary numeric := 0;
  v_required text[] := ARRAY[]::text[];
  v_present text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_blockers text[] := ARRAY[]::text[];
  v_has_contract boolean := false;
  v_has_salary boolean := false;
  v_has_schedule boolean := false;
  v_has_bank boolean := false;
BEGIN
  SELECT e.business_id INTO v_business_id
  FROM public.employees e WHERE e.id = p_employee_id;
  IF v_business_id IS NULL THEN RETURN; END IF;

  SELECT ec.id, ec.wage, ec.working_schedule
    INTO v_contract_id, v_wage, v_working_schedule
  FROM public.employee_contracts ec
  WHERE ec.employee_id = p_employee_id
    AND ec.status = 'running'
    AND ec.start_date <= v_today
    AND (ec.end_date IS NULL OR ec.end_date >= v_today)
  ORDER BY ec.start_date DESC
  LIMIT 1;

  v_has_contract := v_contract_id IS NOT NULL;
  v_has_schedule := v_working_schedule IS NOT NULL AND v_working_schedule <> '';

  IF v_has_contract THEN
    SELECT COALESCE(v_wage, 0) +
           COALESCE((
             SELECT SUM(ccc.amount)
               FROM public.contract_compensation_components ccc
              WHERE ccc.contract_id = v_contract_id
           ), 0)
      INTO v_salary;
    v_has_salary := v_salary > 0;
  END IF;

  SELECT (e.bank_account_number IS NOT NULL AND e.bank_account_number <> '')
      OR (e.bank_name IS NOT NULL AND e.bank_name <> '')
    INTO v_has_bank
  FROM public.employees e WHERE e.id = p_employee_id;

  SELECT COALESCE(array_agg(DISTINCT pref.requirement_key), ARRAY[]::text[])
    INTO v_required
  FROM public.pack_required_employee_fields(v_business_id, 'payroll') pref
  WHERE pref.scope = 'statutory_identifier'
    AND pref.is_required = true
    AND pref.blocks_payroll = true;

  SELECT COALESCE(array_agg(DISTINCT esi.identifier_type), ARRAY[]::text[])
    INTO v_present
  FROM public.employee_statutory_identifiers esi
  WHERE esi.employee_id = p_employee_id
    AND esi.is_active = true
    AND COALESCE(esi.identifier_value, '') <> '';

  SELECT COALESCE(array_agg(k), ARRAY[]::text[]) INTO v_missing
  FROM unnest(v_required) AS k
  WHERE k <> ALL(v_present);

  IF NOT v_has_contract THEN v_blockers := v_blockers || 'Active contract missing'; END IF;
  IF v_has_contract AND NOT v_has_salary THEN v_blockers := v_blockers || 'Salary not set on contract'; END IF;
  IF v_has_contract AND NOT v_has_schedule THEN v_blockers := v_blockers || 'Working schedule missing'; END IF;
  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    v_blockers := v_blockers || ('Missing statutory identifier(s): ' || array_to_string(v_missing, ', '));
  END IF;

  RETURN QUERY SELECT
    p_employee_id,
    v_has_contract, v_has_salary, v_has_schedule, v_has_bank,
    v_required, v_present, v_missing,
    (v_has_contract AND v_has_salary AND v_has_schedule
     AND COALESCE(array_length(v_missing,1),0) = 0),
    v_blockers;
END $function$;
