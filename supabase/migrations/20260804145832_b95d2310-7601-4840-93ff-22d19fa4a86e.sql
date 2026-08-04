CREATE OR REPLACE FUNCTION public.wms_task_telemetry(p_warehouse_id uuid, p_from timestamp with time zone DEFAULT (now() - '7 days'::interval), p_to timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_by_type jsonb;
  v_by_operator jsonb;
  v_totals jsonb;
BEGIN
  SELECT business_id INTO v_business FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_business IS NULL THEN RAISE EXCEPTION 'warehouse not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public._wms_assert_business_access(v_business);

  WITH ev AS (
    SELECT * FROM public.wms_task_events
     WHERE warehouse_id = p_warehouse_id
       AND created_at >= p_from AND created_at < p_to
  ),
  spans AS (
    SELECT task_id, task_type,
           MIN(created_at) FILTER (WHERE to_state = 'claimed')      AS claimed_at,
           MIN(created_at) FILTER (WHERE to_state = 'in_progress')  AS started_at,
           MAX(created_at) FILTER (WHERE to_state = 'completed')    AS completed_at,
           MIN(created_at)                                          AS first_seen,
           -- uuid has no max(); take the actor of the latest completion event.
           (ARRAY_AGG(actor_id ORDER BY created_at DESC)
              FILTER (WHERE to_state = 'completed' AND actor_id IS NOT NULL))[1] AS completed_by,
           COUNT(*) FILTER (WHERE to_state = 'exception')           AS exceptions,
           COUNT(*) FILTER (WHERE event_type = 'lease_reaped'
                              OR reason ILIKE '%reap%')             AS reaps,
           COUNT(*) FILTER (WHERE to_state = 'cancelled')           AS cancels
      FROM ev GROUP BY task_id, task_type
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'task_type', task_type,
      'tasks', tasks,
      'completed', completed,
      'exception_rate', exception_rate,
      'reap_rate', reap_rate,
      'avg_wait_seconds', avg_wait,
      'avg_execution_seconds', avg_exec
    ) ORDER BY task_type), '[]'::jsonb)
  INTO v_by_type
  FROM (
    SELECT task_type::text AS task_type,
           COUNT(*)                                              AS tasks,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL)       AS completed,
           ROUND(AVG(CASE WHEN exceptions > 0 THEN 1 ELSE 0 END)::numeric, 4) AS exception_rate,
           ROUND(AVG(CASE WHEN reaps > 0 THEN 1 ELSE 0 END)::numeric, 4)      AS reap_rate,
           ROUND(AVG(EXTRACT(epoch FROM (COALESCE(claimed_at, started_at) - first_seen)))::numeric, 1) AS avg_wait,
           ROUND(AVG(EXTRACT(epoch FROM (completed_at - COALESCE(started_at, claimed_at))))::numeric, 1) AS avg_exec
      FROM spans GROUP BY task_type
  ) s;

  WITH ev AS (
    SELECT * FROM public.wms_task_events
     WHERE warehouse_id = p_warehouse_id
       AND created_at >= p_from AND created_at < p_to
  ),
  spans AS (
    SELECT task_id, task_type,
           MIN(created_at) FILTER (WHERE to_state = 'in_progress') AS started_at,
           MIN(created_at) FILTER (WHERE to_state = 'claimed')     AS claimed_at,
           MAX(created_at) FILTER (WHERE to_state = 'completed')   AS completed_at,
           (ARRAY_AGG(actor_id ORDER BY created_at DESC)
              FILTER (WHERE to_state = 'completed' AND actor_id IS NOT NULL))[1] AS completed_by,
           COUNT(*) FILTER (WHERE to_state = 'exception')          AS exceptions
      FROM ev GROUP BY task_id, task_type
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'operator_id', operator_id,
           'completed', completed,
           'avg_execution_seconds', avg_exec,
           'exceptions', exceptions
         ) ORDER BY completed DESC), '[]'::jsonb)
  INTO v_by_operator
  FROM (
    SELECT completed_by AS operator_id,
           COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed,
           ROUND(AVG(EXTRACT(epoch FROM (completed_at - COALESCE(started_at, claimed_at))))::numeric, 1) AS avg_exec,
           SUM(exceptions) AS exceptions
      FROM spans
     WHERE completed_by IS NOT NULL
     GROUP BY completed_by
     LIMIT 25
  ) o;

  SELECT jsonb_build_object(
    'events', COUNT(*),
    'tasks_touched', COUNT(DISTINCT task_id),
    'completed', COUNT(*) FILTER (WHERE to_state = 'completed'),
    'cancelled', COUNT(*) FILTER (WHERE to_state = 'cancelled'),
    'exceptions', COUNT(*) FILTER (WHERE to_state = 'exception'),
    'active_operators', COUNT(DISTINCT actor_id) FILTER (WHERE actor_id IS NOT NULL)
  ) INTO v_totals
  FROM public.wms_task_events
   WHERE warehouse_id = p_warehouse_id
     AND created_at >= p_from AND created_at < p_to;

  RETURN jsonb_build_object(
    'warehouse_id', p_warehouse_id,
    'from', p_from, 'to', p_to,
    'totals', v_totals,
    'by_type', v_by_type,
    'by_operator', v_by_operator
  );
END $function$;