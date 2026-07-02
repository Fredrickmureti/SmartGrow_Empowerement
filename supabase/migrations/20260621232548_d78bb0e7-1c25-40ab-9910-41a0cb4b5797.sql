
-- Add p_mine_only parameter to employee list RPCs so the "My drafts" page
-- can scope to the calling user's own draft rows. Additive, default false:
-- existing callers do not pass it and continue to behave identically.

CREATE OR REPLACE FUNCTION public.list_employee_ids_matching(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_ids uuid[] DEFAULT NULL::uuid[],
  p_search text DEFAULT NULL::text,
  p_status text DEFAULT 'all'::text,
  p_department_id uuid DEFAULT NULL::uuid,
  p_position_id uuid DEFAULT NULL::uuid,
  p_location_id uuid DEFAULT NULL::uuid,
  p_health text DEFAULT NULL::text,
  p_mine_only boolean DEFAULT false
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(ARRAY_AGG(e.id ORDER BY e.created_at DESC, e.id DESC), ARRAY[]::uuid[])
  FROM public.v_employees_safe e
  JOIN public.employees emp ON emp.id = e.id
  LEFT JOIN public.v_employee_setup_health h
    ON h.employee_id = e.id
   AND h.organization_id = e.organization_id
   AND h.business_id = e.business_id
  WHERE e.organization_id = p_org_id
    AND e.business_id = p_business_id
    AND (p_branch_ids IS NULL OR e.branch_id = ANY(p_branch_ids))
    AND (
      (p_status = 'drafts'   AND emp.lifecycle_status = 'draft')
      OR (p_status <> 'drafts' AND emp.lifecycle_status <> 'draft' AND (
        p_status = 'all'
        OR (p_status = 'active'   AND e.is_active)
        OR (p_status = 'inactive' AND NOT e.is_active)
      ))
    )
    AND (NOT p_mine_only OR emp.draft_owner_id = auth.uid())
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
$function$;

CREATE OR REPLACE FUNCTION public.list_employees_paged(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_ids uuid[] DEFAULT NULL::uuid[],
  p_search text DEFAULT NULL::text,
  p_status text DEFAULT 'all'::text,
  p_department_id uuid DEFAULT NULL::uuid,
  p_position_id uuid DEFAULT NULL::uuid,
  p_location_id uuid DEFAULT NULL::uuid,
  p_health text DEFAULT NULL::text,
  p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_cursor_id uuid DEFAULT NULL::uuid,
  p_page_size integer DEFAULT 50,
  p_mine_only boolean DEFAULT false
)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT to_jsonb(t) FROM (
    SELECT
      e.*,
      emp.lifecycle_status AS lifecycle_status,
      emp.draft_owner_id   AS draft_owner_id,
      h.verdict AS health_verdict,
      mgr.first_name AS manager_first_name,
      mgr.last_name AS manager_last_name
    FROM public.v_employees_safe e
    JOIN public.employees emp ON emp.id = e.id
    LEFT JOIN public.v_employee_setup_health h
      ON h.employee_id = e.id
     AND h.organization_id = e.organization_id
     AND h.business_id = e.business_id
    LEFT JOIN public.employees mgr ON mgr.id = e.manager_id
    WHERE e.organization_id = p_org_id
      AND e.business_id = p_business_id
      AND (p_branch_ids IS NULL OR e.branch_id = ANY(p_branch_ids))
      AND (
        (p_status = 'drafts'   AND emp.lifecycle_status = 'draft')
        OR (p_status <> 'drafts' AND emp.lifecycle_status <> 'draft' AND (
          p_status = 'all'
          OR (p_status = 'active'   AND e.is_active)
          OR (p_status = 'inactive' AND NOT e.is_active)
        ))
      )
      AND (NOT p_mine_only OR emp.draft_owner_id = auth.uid())
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
$function$;

-- Lightweight count helper for the user-menu "My drafts" badge.
-- Counts only drafts owned by the calling user, scoped to org+business.
CREATE OR REPLACE FUNCTION public.count_my_employee_drafts(
  p_org_id uuid,
  p_business_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(COUNT(*), 0)::int
  FROM public.employees
  WHERE organization_id = p_org_id
    AND business_id IS NOT DISTINCT FROM p_business_id
    AND lifecycle_status = 'draft'
    AND draft_owner_id = auth.uid();
$function$;

GRANT EXECUTE ON FUNCTION public.count_my_employee_drafts(uuid, uuid) TO authenticated;
