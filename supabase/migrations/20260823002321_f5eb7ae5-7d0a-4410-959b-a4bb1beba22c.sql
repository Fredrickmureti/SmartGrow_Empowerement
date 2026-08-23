CREATE OR REPLACE FUNCTION public.get_budget_document_header(_budget_id uuid)
 RETURNS TABLE(
   budget_id uuid,
   budget_code text,
   budget_name text,
   description text,
   fiscal_year integer,
   status text,
   currency_code text,
   organization_id uuid,
   business_id uuid,
   business_name text,
   branch_id uuid,
   branch_name text,
   scope_label text,
   period_start date,
   period_end date,
   created_by uuid,
   created_by_name text,
   created_at timestamptz,
   approved_by uuid,
   approved_by_name text,
   approved_at timestamptz,
   revision_count integer,
   last_revision_number integer,
   last_revision_at timestamptz,
   line_count integer
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
BEGIN
  -- Same gate as every other budget read: membership, module permission and
  -- branch visibility are decided here, never by the caller.
  b := public._budget_assert_read(_budget_id);

  RETURN QUERY
  WITH cal AS (
    SELECT MIN(m.start_date) AS period_start,
           MAX(m.end_date)   AS period_end
    FROM public.budget_fiscal_months(b.business_id, b.fiscal_year) m
  ),
  rev AS (
    SELECT COUNT(*)::int AS revision_count,
           MAX(r.revision_number) AS last_revision_number,
           MAX(r.created_at) AS last_revision_at
    FROM public.budget_revisions r
    WHERE r.budget_id = b.id
  ),
  lines AS (
    SELECT COUNT(*)::int AS line_count
    FROM public.budget_items bi
    WHERE bi.budget_id = b.id
  )
  SELECT b.id,
         b.budget_code,
         b.name,
         b.description,
         b.fiscal_year,
         b.status::text,
         b.currency_code,
         b.organization_id,
         b.business_id,
         biz.name,
         b.branch_id,
         br.name,
         COALESCE(br.name, 'All branches'),
         cal.period_start,
         cal.period_end,
         b.created_by,
         cp.full_name,
         b.created_at,
         b.approved_by,
         ap.full_name,
         b.approved_at,
         rev.revision_count,
         rev.last_revision_number,
         rev.last_revision_at,
         lines.line_count
  FROM cal, rev, lines
  LEFT JOIN public.businesses biz ON biz.id = b.business_id
  LEFT JOIN public.branches br ON br.id = b.branch_id
  -- profiles is keyed by user_id; joining on id silently yields no name.
  LEFT JOIN public.profiles cp ON cp.user_id = b.created_by
  LEFT JOIN public.profiles ap ON ap.user_id = b.approved_by;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_budget_document_header(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_budget_document_header(uuid) TO authenticated, service_role;