
-- F6: Server-side cursor pagination + filtering for the Employees directory.
-- All three functions are SECURITY INVOKER so the underlying RLS on
-- v_employees_safe / v_employee_setup_health enforces visibility.

CREATE OR REPLACE FUNCTION public.list_employees_paged(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_ids uuid[] DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_department_id uuid DEFAULT NULL,
  p_position_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_health text DEFAULT NULL,
  p_cursor_created_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_page_size int DEFAULT 50
)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT to_jsonb(t) FROM (
    SELECT
      e.*,
      h.verdict AS health_verdict,
      mgr.first_name AS manager_first_name,
      mgr.last_name AS manager_last_name
    FROM public.v_employees_safe e
    LEFT JOIN public.v_employee_setup_health h
      ON h.employee_id = e.id
     AND h.organization_id = e.organization_id
     AND h.business_id = e.business_id
    LEFT JOIN public.employees mgr ON mgr.id = e.manager_id
    WHERE e.organization_id = p_org_id
      AND e.business_id = p_business_id
      AND (p_branch_ids IS NULL OR e.branch_id = ANY(p_branch_ids))
      AND (
        p_status = 'all'
        OR (p_status = 'active' AND e.is_active)
        OR (p_status = 'inactive' AND NOT e.is_active)
      )
      AND (p_department_id IS NULL OR e.department_id = p_department_id)
      AND (p_position_id  IS NULL OR e.job_position_id = p_position_id)
      AND (p_location_id  IS NULL OR e.work_location_id = p_location_id)
      AND (p_health IS NULL OR h.verdict = p_health)
      AND (
        p_search IS NULL OR length(trim(p_search)) = 0
        OR e.first_name      ILIKE '%' || p_search || '%'
        OR e.last_name       ILIKE '%' || p_search || '%'
        OR e.employee_number ILIKE '%' || p_search || '%'
        OR e.email           ILIKE '%' || p_search || '%'
      )
      AND (
        p_cursor_created_at IS NULL
        OR (e.created_at, e.id) < (p_cursor_created_at, p_cursor_id)
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200)
  ) t;
$$;

REVOKE ALL ON FUNCTION public.list_employees_paged(uuid, uuid, uuid[], text, text, uuid, uuid, uuid, text, timestamptz, uuid, int) FROM public;
GRANT EXECUTE ON FUNCTION public.list_employees_paged(uuid, uuid, uuid[], text, text, uuid, uuid, uuid, text, timestamptz, uuid, int) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.get_employee_directory_stats(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      e.is_active,
      e.basic_salary, e.housing_allowance, e.transport_allowance,
      e.other_allowances,
      COALESCE(h.verdict, 'inactive') AS verdict
    FROM public.v_employees_safe e
    LEFT JOIN public.v_employee_setup_health h
      ON h.employee_id = e.id
     AND h.organization_id = e.organization_id
     AND h.business_id = e.business_id
    WHERE e.organization_id = p_org_id
      AND e.business_id = p_business_id
      AND (p_branch_ids IS NULL OR EXISTS (
        SELECT 1 FROM unnest(p_branch_ids) b(id) WHERE TRUE
      ))
  )
  SELECT jsonb_build_object(
    'total', COUNT(*)::int,
    'active', COUNT(*) FILTER (WHERE is_active)::int,
    'inactive', COUNT(*) FILTER (WHERE NOT is_active)::int,
    'needs_attention',
      COUNT(*) FILTER (WHERE is_active AND verdict IN ('incomplete','blocked'))::int,
    'monthly_payroll',
      COALESCE(SUM(
        CASE WHEN is_active THEN
          COALESCE(basic_salary,0)
          + COALESCE(housing_allowance,0)
          + COALESCE(transport_allowance,0)
          + COALESCE((
              SELECT SUM((value)::numeric)
              FROM jsonb_each_text(COALESCE(other_allowances, '{}'::jsonb))
            ), 0)
        ELSE 0 END
      ), 0)
  )
  FROM base;
$$;

REVOKE ALL ON FUNCTION public.get_employee_directory_stats(uuid, uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.get_employee_directory_stats(uuid, uuid, uuid[]) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.list_employee_ids_matching(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_ids uuid[] DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_department_id uuid DEFAULT NULL,
  p_position_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_health text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(ARRAY_AGG(e.id ORDER BY e.created_at DESC, e.id DESC), ARRAY[]::uuid[])
  FROM public.v_employees_safe e
  LEFT JOIN public.v_employee_setup_health h
    ON h.employee_id = e.id
   AND h.organization_id = e.organization_id
   AND h.business_id = e.business_id
  WHERE e.organization_id = p_org_id
    AND e.business_id = p_business_id
    AND (p_branch_ids IS NULL OR e.branch_id = ANY(p_branch_ids))
    AND (
      p_status = 'all'
      OR (p_status = 'active' AND e.is_active)
      OR (p_status = 'inactive' AND NOT e.is_active)
    )
    AND (p_department_id IS NULL OR e.department_id = p_department_id)
    AND (p_position_id  IS NULL OR e.job_position_id = p_position_id)
    AND (p_location_id  IS NULL OR e.work_location_id = p_location_id)
    AND (p_health IS NULL OR h.verdict = p_health)
    AND (
      p_search IS NULL OR length(trim(p_search)) = 0
      OR e.first_name      ILIKE '%' || p_search || '%'
      OR e.last_name       ILIKE '%' || p_search || '%'
      OR e.employee_number ILIKE '%' || p_search || '%'
      OR e.email           ILIKE '%' || p_search || '%'
    );
$$;

REVOKE ALL ON FUNCTION public.list_employee_ids_matching(uuid, uuid, uuid[], text, text, uuid, uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.list_employee_ids_matching(uuid, uuid, uuid[], text, text, uuid, uuid, uuid, text) TO authenticated, service_role;
