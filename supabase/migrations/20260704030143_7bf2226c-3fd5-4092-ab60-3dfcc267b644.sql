
CREATE OR REPLACE FUNCTION public.wet_impact_metrics(
  _org_id      uuid,
  _business_id uuid
)
RETURNS TABLE (
  work_entry_type_id uuid,
  code               text,
  rows_last_90d      bigint,
  employees_last_90d bigint,
  rules_referencing  bigint,
  leave_types_routed bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH types AS (
    SELECT id, code
      FROM public.payroll_work_entry_types
     WHERE organization_id = _org_id
       AND (business_id = _business_id OR business_id IS NULL)
  ),
  entries AS (
    SELECT pwe.work_entry_type_id,
           COUNT(*)::bigint                        AS rows_last_90d,
           COUNT(DISTINCT pwe.employee_id)::bigint AS employees_last_90d
      FROM public.payroll_work_entries pwe
     WHERE pwe.organization_id = _org_id
       AND (_business_id IS NULL OR pwe.business_id = _business_id)
       AND pwe.work_date_start >= (CURRENT_DATE - INTERVAL '90 days')
     GROUP BY pwe.work_entry_type_id
  ),
  rule_refs AS (
    SELECT t.id AS work_entry_type_id,
           COUNT(*)::bigint AS rules_referencing
      FROM types t
      JOIN public.payroll_salary_rules r
        ON r.organization_id = _org_id
       AND r.is_active = true
       AND (
         r.condition_expression ILIKE '%worked_hours[' || '''' || t.code || '''' || ']%'
         OR r.amount_expression ILIKE '%worked_hours['  || '''' || t.code || '''' || ']%'
         OR r.condition_expression ILIKE '%worked_hours["' || t.code || '"]%'
         OR r.amount_expression ILIKE '%worked_hours["'   || t.code || '"]%'
       )
     GROUP BY t.id
  ),
  leave_refs AS (
    SELECT lt.work_entry_type_id, COUNT(*)::bigint AS leave_types_routed
      FROM public.leave_types lt
     WHERE lt.organization_id = _org_id
       AND lt.work_entry_type_id IS NOT NULL
     GROUP BY lt.work_entry_type_id
  )
  SELECT t.id, t.code,
         COALESCE(e.rows_last_90d, 0),
         COALESCE(e.employees_last_90d, 0),
         COALESCE(rr.rules_referencing, 0),
         COALESCE(lr.leave_types_routed, 0)
    FROM types t
    LEFT JOIN entries e     ON e.work_entry_type_id = t.id
    LEFT JOIN rule_refs rr  ON rr.work_entry_type_id = t.id
    LEFT JOIN leave_refs lr ON lr.work_entry_type_id = t.id;
$$;

GRANT EXECUTE ON FUNCTION public.wet_impact_metrics(uuid, uuid)
  TO authenticated, service_role;
