SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE OR REPLACE FUNCTION public.compute_project_profitability(_project_id uuid, _business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_proj public.projects%ROWTYPE;
  v_base_currency text;
  v_cost numeric := 0;
  v_revenue numeric := 0;
  v_committed_cost numeric := 0;
  v_committed_revenue numeric := 0;
  v_unconverted_cost_count bigint := 0;
  v_unconverted_revenue_count bigint := 0;
  v_planned_hours numeric := 0;
  v_logged_hours numeric := 0;
  v_cost_breakdown jsonb := '{}'::jsonb;
  v_revenue_breakdown jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_proj
  FROM public.projects
  WHERE id = _project_id;

  IF v_proj.id IS NULL THEN
    RAISE EXCEPTION 'Project % not found', _project_id;
  END IF;

  IF NOT public.can_access_project(_project_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT b.base_currency INTO v_base_currency
  FROM public.businesses b
  WHERE b.id = COALESCE(_business_id, v_proj.business_id);

  SELECT
    COALESCE(SUM(amount_base) FILTER (WHERE entry_nature = 'actual'), 0),
    COALESCE(SUM(amount_base) FILTER (WHERE entry_nature = 'commitment'), 0),
    COUNT(*) FILTER (WHERE amount_base IS NULL)
  INTO v_cost, v_committed_cost, v_unconverted_cost_count
  FROM public.project_cost_entries
  WHERE project_id = _project_id
    AND (_business_id IS NULL OR business_id = _business_id);

  SELECT
    COALESCE(SUM(amount_base) FILTER (WHERE entry_nature = 'actual'), 0),
    COALESCE(SUM(amount_base) FILTER (WHERE entry_nature = 'commitment'), 0),
    COUNT(*) FILTER (WHERE amount_base IS NULL)
  INTO v_revenue, v_committed_revenue, v_unconverted_revenue_count
  FROM public.project_revenue_entries
  WHERE project_id = _project_id
    AND (_business_id IS NULL OR business_id = _business_id);

  SELECT COALESCE(SUM(planned_hours), 0), COALESCE(SUM(effective_hours), 0)
  INTO v_planned_hours, v_logged_hours
  FROM public.project_tasks
  WHERE project_id = _project_id
    AND COALESCE(is_active, true) = true;

  SELECT COALESCE(jsonb_object_agg(source_type, total), '{}'::jsonb)
  INTO v_cost_breakdown
  FROM (
    SELECT source_type, SUM(amount_base) AS total
    FROM public.project_cost_entries
    WHERE project_id = _project_id
      AND entry_nature = 'actual'
      AND amount_base IS NOT NULL
      AND (_business_id IS NULL OR business_id = _business_id)
    GROUP BY source_type
  ) c;

  SELECT COALESCE(jsonb_object_agg(source_type, total), '{}'::jsonb)
  INTO v_revenue_breakdown
  FROM (
    SELECT source_type, SUM(amount_base) AS total
    FROM public.project_revenue_entries
    WHERE project_id = _project_id
      AND entry_nature = 'actual'
      AND amount_base IS NOT NULL
      AND (_business_id IS NULL OR business_id = _business_id)
    GROUP BY source_type
  ) r;

  RETURN jsonb_build_object(
    'project_id', _project_id,
    'business_id', _business_id,
    'currency', v_base_currency,
    'cost_total', v_cost,
    'revenue_total', v_revenue,
    'committed_cost_total', v_committed_cost,
    'committed_revenue_total', v_committed_revenue,
    'margin', v_revenue - v_cost,
    'margin_pct', CASE WHEN v_revenue = 0 THEN NULL ELSE round(((v_revenue - v_cost) / v_revenue) * 100, 2) END,
    'has_unconverted_entries', (v_unconverted_cost_count + v_unconverted_revenue_count) > 0,
    'unconverted_cost_count', v_unconverted_cost_count,
    'unconverted_revenue_count', v_unconverted_revenue_count,
    'planned_hours', v_planned_hours,
    'logged_hours', v_logged_hours,
    'budget', v_proj.budget,
    'budget_used_pct', CASE
      WHEN v_proj.budget IS NULL OR v_proj.budget = 0 THEN NULL
      ELSE round((v_cost / v_proj.budget) * 100, 2)
    END,
    'cost_by_source', v_cost_breakdown,
    'revenue_by_source', v_revenue_breakdown
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_project_profitability(_project_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.compute_project_profitability(_project_id, NULL::uuid);
$function$;