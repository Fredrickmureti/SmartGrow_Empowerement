CREATE OR REPLACE FUNCTION public.wms_zone_load(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  WITH open_tasks AS (
    SELECT
      COALESCE(t.zone_id, t.source_location_id, t.destination_location_id) AS loc_id,
      t.state::text AS tstate,
      t.sla_at,
      t.created_at
    FROM public.wms_tasks t
    WHERE t.business_id = p_business_id
      AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
      AND t.state::text IN ('pending','available','assigned','claimed','in_progress','paused','exception')
  ),
  agg AS (
    SELECT
      o.loc_id,
      COUNT(*)                                                       AS backlog,
      COUNT(*) FILTER (WHERE o.tstate = 'in_progress')                AS in_progress,
      COUNT(*) FILTER (WHERE o.tstate IN ('exception','paused'))       AS blocked,
      COUNT(*) FILTER (WHERE o.sla_at IS NOT NULL AND o.sla_at < now()) AS sla_breached,
      MAX(EXTRACT(epoch FROM (now() - o.created_at)))::bigint          AS oldest_age_seconds
    FROM open_tasks o
    GROUP BY o.loc_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'location_id', a.loc_id,
           'label', COALESCE(l.name, l.code, 'Unassigned'),
           'code', l.code,
           'structure_level', l.structure_level,
           'backlog', a.backlog,
           'in_progress', a.in_progress,
           'blocked', a.blocked,
           'sla_breached', a.sla_breached,
           'oldest_age_seconds', a.oldest_age_seconds
         ) ORDER BY a.backlog DESC), '[]'::jsonb)
    INTO v_rows
  FROM (SELECT * FROM agg ORDER BY backlog DESC LIMIT 40) a
  LEFT JOIN public.stock_locations l ON l.id = a.loc_id;

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'zones', v_rows
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_zone_load(uuid, uuid) TO authenticated;