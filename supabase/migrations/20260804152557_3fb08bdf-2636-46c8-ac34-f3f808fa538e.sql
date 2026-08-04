
-- ============================================================
-- Warehouse Overview command centre — read-only aggregates.
-- ADR 0102. No new tables; all three functions are STABLE reads
-- scoped through _wms_assert_business_access.
-- ============================================================

CREATE OR REPLACE FUNCTION public.wms_overview_capacity(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  WITH loc AS (
    SELECT l.*
      FROM public.stock_locations l
     WHERE l.business_id = p_business_id
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
  ),
  q AS (
    SELECT sq.location_id,
           sum(sq.quantity) AS qty,
           sum(COALESCE(sq.reserved_quantity, 0)) AS reserved
      FROM public.stock_quants sq
      JOIN loc l ON l.id = sq.location_id
     GROUP BY sq.location_id
  ),
  binned AS (
    SELECT l.id,
           l.location_type,
           l.usage,
           l.is_active,
           l.is_receiving_staging,
           COALESCE(l.capacity_max_units, 0) AS cap,
           COALESCE(q.qty, 0) AS qty
      FROM loc l
      LEFT JOIN q ON q.location_id = l.id
  ),
  zones AS (
    SELECT b.id, b.cap, b.qty
      FROM binned b
     WHERE b.cap > 0
  ),
  docks AS (
    SELECT d.id
      FROM public.warehouse_docks d
     WHERE d.business_id = p_business_id
       AND d.is_active
       AND (p_warehouse_id IS NULL OR d.warehouse_id = p_warehouse_id)
  ),
  busy_docks AS (
    SELECT DISTINCT a.dock_id
      FROM public.wms_dock_appointments a
     WHERE a.business_id = p_business_id
       AND a.dock_id IS NOT NULL
       AND (p_warehouse_id IS NULL OR a.warehouse_id = p_warehouse_id)
       AND a.state NOT IN ('cancelled', 'completed', 'departed', 'no_show')
       AND a.window_start <= now() + interval '1 hour'
       AND COALESCE(a.window_end, a.window_start + interval '2 hours') >= now()
  ),
  staging AS (
    SELECT count(*)::int AS staging_locations,
           count(*) FILTER (WHERE b.qty > 0)::int AS staging_occupied
      FROM binned b
     WHERE b.is_receiving_staging OR b.location_type = 'staging'
  )
  SELECT jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'total_locations', (SELECT count(*)::int FROM binned),
    'active_locations', (SELECT count(*) FILTER (WHERE is_active)::int FROM binned),
    'blocked_locations', (SELECT count(*) FILTER (WHERE NOT is_active)::int FROM binned),
    'quarantine_locations', (SELECT count(*) FILTER (WHERE location_type = 'quarantine')::int FROM binned),
    'quarantine_occupied', (SELECT count(*) FILTER (WHERE location_type = 'quarantine' AND qty > 0)::int FROM binned),
    'capacity_units', (SELECT COALESCE(sum(cap), 0)::numeric FROM zones),
    'occupied_units', (SELECT COALESCE(sum(least(qty, cap)), 0)::numeric FROM zones),
    'occupancy_pct', (
      SELECT CASE WHEN COALESCE(sum(cap), 0) > 0
                  THEN round(100 * sum(least(qty, cap)) / sum(cap), 1)
                  ELSE NULL END
        FROM zones
    ),
    'measured_locations', (SELECT count(*)::int FROM zones),
    'full_locations', (SELECT count(*) FILTER (WHERE cap > 0 AND qty >= cap)::int FROM zones),
    'empty_locations', (SELECT count(*) FILTER (WHERE cap > 0 AND qty = 0)::int FROM zones),
    'staging_locations', (SELECT staging_locations FROM staging),
    'staging_occupied', (SELECT staging_occupied FROM staging),
    'dock_count', (SELECT count(*)::int FROM docks),
    'dock_busy', (SELECT count(*)::int FROM busy_docks bd WHERE bd.dock_id IN (SELECT id FROM docks))
  ) INTO v_result;

  RETURN v_result;
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_overview_capacity(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_equipment_health(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  WITH d AS (
    SELECT da.id,
           da.display_name,
           da.role,
           da.transport,
           da.status,
           da.enabled,
           da.last_seen_at,
           da.last_error
      FROM public.device_assignments da
     WHERE da.business_id = p_business_id
       AND da.enabled
  ),
  classed AS (
    SELECT d.*,
           CASE
             WHEN d.last_error IS NOT NULL THEN 'error'
             WHEN d.last_seen_at IS NULL THEN 'unknown'
             WHEN d.last_seen_at < now() - interval '15 minutes' THEN 'stale'
             ELSE 'online'
           END AS health
      FROM d
  )
  SELECT jsonb_build_object(
    'business_id', p_business_id,
    'warehouse_id', p_warehouse_id,
    'generated_at', now(),
    'total', (SELECT count(*)::int FROM classed),
    'online', (SELECT count(*) FILTER (WHERE health = 'online')::int FROM classed),
    'stale', (SELECT count(*) FILTER (WHERE health = 'stale')::int FROM classed),
    'error', (SELECT count(*) FILTER (WHERE health = 'error')::int FROM classed),
    'unknown', (SELECT count(*) FILTER (WHERE health = 'unknown')::int FROM classed),
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id,
               'name', COALESCE(c.display_name, c.role, 'Device'),
               'role', c.role,
               'transport', c.transport,
               'status', c.status,
               'health', c.health,
               'last_seen_at', c.last_seen_at,
               'last_error', c.last_error
             ) ORDER BY (c.health = 'online'), c.last_seen_at DESC NULLS LAST)
        FROM classed c
       WHERE c.health <> 'online'
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_equipment_health(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wms_activity_feed(
  p_business_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 40
)
RETURNS TABLE(
  id uuid,
  event_type text,
  source_doc_type text,
  source_doc_id uuid,
  warehouse_id uuid,
  actor_user_id uuid,
  payload jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
BEGIN
  PERFORM public._wms_assert_business_access(p_business_id);

  SELECT b.organization_id INTO v_org
    FROM public.businesses b WHERE b.id = p_business_id;
  IF v_org IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT e.id, e.event_type, e.source_doc_type, e.source_doc_id,
         e.warehouse_id, e.actor_user_id, e.payload, e.created_at
    FROM public.business_event_outbox e
   WHERE e.org_id = v_org
     AND (p_warehouse_id IS NULL OR e.warehouse_id = p_warehouse_id)
     AND (e.event_type LIKE 'warehouse.%' OR e.event_type LIKE 'stock.movement.%')
     AND e.created_at > now() - interval '3 days'
   ORDER BY e.created_at DESC
   LIMIT greatest(1, least(COALESCE(p_limit, 40), 200));
END $function$;

GRANT EXECUTE ON FUNCTION public.wms_activity_feed(uuid, uuid, integer) TO authenticated;
