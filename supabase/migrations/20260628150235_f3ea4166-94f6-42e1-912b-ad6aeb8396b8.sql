
-- 1. Canonical directory view: every consumer (paged list, stats, ids,
--    headcount, org chart, payroll readiness) MUST read from this view.
CREATE OR REPLACE VIEW public.v_employee_directory
WITH (security_invoker = on) AS
SELECT
  e.*,
  emp.lifecycle_status AS _lifecycle_status,
  emp.draft_owner_id   AS _draft_owner_id,
  h.verdict            AS health_verdict,
  mgr.first_name       AS manager_first_name,
  mgr.last_name        AS manager_last_name
FROM public.v_employees_safe e
JOIN public.employees emp ON emp.id = e.id
LEFT JOIN public.v_employee_setup_health h
  ON h.employee_id = e.id
 AND h.organization_id = e.organization_id
 AND h.business_id = e.business_id
LEFT JOIN public.employees mgr ON mgr.id = e.manager_id;

GRANT SELECT ON public.v_employee_directory TO authenticated;
GRANT SELECT ON public.v_employee_directory TO service_role;

-- 2. Shared filter — the ONLY place directory predicates live.
--    Lifecycle, branch, search, etc. all evaluated identically for every
--    consumer. Branch-null employees are excluded when a branch list is
--    provided (Strict policy — see ADR-0039).
CREATE OR REPLACE FUNCTION public.filtered_employee_directory(
  p_org_id        uuid,
  p_business_id   uuid,
  p_branch_ids    uuid[] DEFAULT NULL,
  p_status        text   DEFAULT 'all',
  p_department_id uuid   DEFAULT NULL,
  p_position_id   uuid   DEFAULT NULL,
  p_location_id   uuid   DEFAULT NULL,
  p_health        text   DEFAULT NULL,
  p_search        text   DEFAULT NULL,
  p_mine_only     boolean DEFAULT false
) RETURNS SETOF public.v_employee_directory
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT d.*
  FROM public.v_employee_directory d
  WHERE d.organization_id = p_org_id
    AND d.business_id = p_business_id
    AND (p_branch_ids IS NULL OR d.branch_id = ANY(p_branch_ids))
    AND (
      (p_status = 'drafts'   AND d._lifecycle_status = 'draft')
      OR (p_status <> 'drafts' AND d._lifecycle_status <> 'draft' AND (
        p_status = 'all'
        OR (p_status = 'active'   AND d.is_active)
        OR (p_status = 'inactive' AND NOT d.is_active)
      ))
    )
    AND (NOT p_mine_only OR d._draft_owner_id = auth.uid())
    AND (p_department_id IS NULL OR d.department_id = p_department_id)
    AND (p_position_id   IS NULL OR d.job_position_id = p_position_id)
    AND (p_location_id   IS NULL OR d.work_location_id = p_location_id)
    AND (p_health IS NULL OR d.health_verdict = p_health)
    AND (
      p_search IS NULL OR length(trim(p_search)) = 0
      OR d.first_name      ILIKE '%' || p_search || '%'
      OR d.last_name       ILIKE '%' || p_search || '%'
      OR d.employee_number ILIKE '%' || p_search || '%'
      OR d.email           ILIKE '%' || p_search || '%'
    );
$function$;

GRANT EXECUTE ON FUNCTION public.filtered_employee_directory(
  uuid,uuid,uuid[],text,uuid,uuid,uuid,text,text,boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.filtered_employee_directory(
  uuid,uuid,uuid[],text,uuid,uuid,uuid,text,text,boolean
) TO service_role;

-- 3. Drop the old, drifted RPCs (both overloads where applicable) so
--    PostgREST resolves each function name unambiguously and nothing
--    keeps reading the pre-fix predicates.
DROP FUNCTION IF EXISTS public.list_employees_paged(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,timestamptz,uuid,integer
);
DROP FUNCTION IF EXISTS public.list_employees_paged(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,timestamptz,uuid,integer,boolean
);
DROP FUNCTION IF EXISTS public.list_employee_ids_matching(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text
);
DROP FUNCTION IF EXISTS public.list_employee_ids_matching(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,boolean
);
DROP FUNCTION IF EXISTS public.get_employee_directory_stats(uuid,uuid,uuid[]);

-- 4. Re-create each RPC as a thin wrapper over the shared filter.
--    Same predicates, single source of truth.
CREATE OR REPLACE FUNCTION public.list_employees_paged(
  p_org_id              uuid,
  p_business_id         uuid,
  p_branch_ids          uuid[]      DEFAULT NULL,
  p_search              text        DEFAULT NULL,
  p_status              text        DEFAULT 'all',
  p_department_id       uuid        DEFAULT NULL,
  p_position_id         uuid        DEFAULT NULL,
  p_location_id         uuid        DEFAULT NULL,
  p_health              text        DEFAULT NULL,
  p_cursor_created_at   timestamptz DEFAULT NULL,
  p_cursor_id           uuid        DEFAULT NULL,
  p_page_size           integer     DEFAULT 50,
  p_mine_only           boolean     DEFAULT false
) RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT to_jsonb(t)
  FROM (
    SELECT f.*
    FROM public.filtered_employee_directory(
      p_org_id, p_business_id, p_branch_ids, p_status,
      p_department_id, p_position_id, p_location_id, p_health,
      p_search, p_mine_only
    ) f
    WHERE (
      p_cursor_created_at IS NULL
      OR (f.created_at, f.id) < (p_cursor_created_at, p_cursor_id)
    )
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 200)
  ) t;
$function$;

GRANT EXECUTE ON FUNCTION public.list_employees_paged(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,timestamptz,uuid,integer,boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_employees_paged(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,timestamptz,uuid,integer,boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.list_employee_ids_matching(
  p_org_id        uuid,
  p_business_id   uuid,
  p_branch_ids    uuid[] DEFAULT NULL,
  p_search        text   DEFAULT NULL,
  p_status        text   DEFAULT 'all',
  p_department_id uuid   DEFAULT NULL,
  p_position_id   uuid   DEFAULT NULL,
  p_location_id   uuid   DEFAULT NULL,
  p_health        text   DEFAULT NULL,
  p_mine_only     boolean DEFAULT false
) RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(ARRAY_AGG(f.id ORDER BY f.created_at DESC, f.id DESC), ARRAY[]::uuid[])
  FROM public.filtered_employee_directory(
    p_org_id, p_business_id, p_branch_ids, p_status,
    p_department_id, p_position_id, p_location_id, p_health,
    p_search, p_mine_only
  ) f;
$function$;

GRANT EXECUTE ON FUNCTION public.list_employee_ids_matching(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_employee_ids_matching(
  uuid,uuid,uuid[],text,text,uuid,uuid,uuid,text,boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_employee_directory_stats(
  p_org_id      uuid,
  p_business_id uuid,
  p_branch_ids  uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH base AS (
    -- Use the shared filter with status='all' so the stat cards count
    -- exactly what `list_employees_paged(p_status='all')` would return.
    -- Drafts are excluded; branch filter is honored identically.
    SELECT
      f.is_active,
      f.basic_salary, f.housing_allowance, f.transport_allowance,
      f.other_allowances,
      COALESCE(f.health_verdict, 'inactive') AS verdict
    FROM public.filtered_employee_directory(
      p_org_id, p_business_id, p_branch_ids, 'all',
      NULL, NULL, NULL, NULL, NULL, false
    ) f
  ),
  drafts AS (
    -- Drafts are reported separately so the UI can surface the "draft"
    -- count without contaminating active/inactive/total.
    SELECT COUNT(*)::int AS n
    FROM public.filtered_employee_directory(
      p_org_id, p_business_id, p_branch_ids, 'drafts',
      NULL, NULL, NULL, NULL, NULL, false
    )
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::int FROM base),
    'active', (SELECT COUNT(*) FILTER (WHERE is_active)::int FROM base),
    'inactive', (SELECT COUNT(*) FILTER (WHERE NOT is_active)::int FROM base),
    'drafts', (SELECT n FROM drafts),
    'needs_attention',
      (SELECT COUNT(*) FILTER (WHERE is_active AND verdict IN ('incomplete','blocked'))::int FROM base),
    'monthly_payroll',
      (SELECT COALESCE(SUM(
        CASE WHEN is_active THEN
          COALESCE(basic_salary,0)
          + COALESCE(housing_allowance,0)
          + COALESCE(transport_allowance,0)
          + COALESCE((
              SELECT SUM((value)::numeric)
              FROM jsonb_each_text(COALESCE(other_allowances, '{}'::jsonb))
            ), 0)
        ELSE 0 END
      ), 0) FROM base)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.get_employee_directory_stats(uuid,uuid,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_directory_stats(uuid,uuid,uuid[]) TO service_role;
