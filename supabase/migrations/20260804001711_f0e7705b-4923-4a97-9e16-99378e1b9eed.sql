CREATE OR REPLACE FUNCTION public.wms_detect_operational_exceptions(
  p_warehouse_id uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r RECORD; v_n integer := 0;
BEGIN
  -- Trailers overstaying in the yard (> 24h dwell, not departed).
  FOR r IN
    SELECT v.id, v.warehouse_id, v.trailer_ref, v.carrier_id, v.arrived_at,
           EXTRACT(EPOCH FROM (now() - v.arrived_at))/3600 AS hours
      FROM public.wms_trailer_visits v
     WHERE v.departed_at IS NULL
       AND v.arrived_at < now() - interval '24 hours'
       AND (p_warehouse_id IS NULL OR v.warehouse_id = p_warehouse_id)
  LOOP
    PERFORM public.wms_raise_exception(
      p_warehouse_id => r.warehouse_id, p_kind => 'trailer_overstay',
      p_reason => format('Trailer %s on site for %s hours', COALESCE(r.trailer_ref,'—'), round(r.hours)),
      p_aggregate_type => 'wms_trailer_visit', p_aggregate_id => r.id,
      p_details => jsonb_build_object('trailer_ref', r.trailer_ref, 'carrier_id', r.carrier_id,
                                      'arrived_at', r.arrived_at, 'dwell_hours', round(r.hours)),
      p_idempotency_key => 'wms.exception:trailer_overstay:wms_trailer_visit:' || r.id::text,
      p_links => jsonb_build_array(jsonb_build_object(
        'link_type','trailer_visit','record_id', r.id, 'route_path','/warehouse-app/yard'))
    );
    v_n := v_n + 1;
  END LOOP;

  -- Tasks past their SLA that are still open.
  FOR r IN
    SELECT t.id, t.warehouse_id, t.task_type, t.sla_at, t.assignee_user_id, t.lpn_id
      FROM public.wms_tasks t
     WHERE t.state::text IN ('pending','available','claimed','in_progress')
       AND t.sla_at IS NOT NULL AND t.sla_at < now()
       AND (p_warehouse_id IS NULL OR t.warehouse_id = p_warehouse_id)
     LIMIT 500
  LOOP
    PERFORM public.wms_raise_exception(
      p_warehouse_id => r.warehouse_id,
      p_kind => CASE WHEN r.task_type::text = 'pick' THEN 'pick_sla_breach'::public.wms_exception_kind
                     ELSE 'stale_task'::public.wms_exception_kind END,
      p_reason => format('%s task past SLA', replace(r.task_type::text,'_',' ')),
      p_aggregate_type => 'wms_task', p_aggregate_id => r.id, p_task_id => r.id, p_lpn_id => r.lpn_id,
      p_details => jsonb_build_object('task_type', r.task_type, 'sla_at', r.sla_at,
                                      'assignee_user_id', r.assignee_user_id),
      p_idempotency_key => 'wms.exception:task_sla:wms_task:' || r.id::text,
      p_links => jsonb_build_array(jsonb_build_object(
        'link_type','task','record_id', r.id, 'route_path','/warehouse-app/tasks'))
    );
    v_n := v_n + 1;
  END LOOP;

  -- Expired stock still sitting in pickable locations.
  FOR r IN
    SELECT q.id, q.product_id, q.location_id, q.lot_number, q.quantity, l.warehouse_id, sl.expiry_date
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN LATERAL (
        SELECT max(rl.expiry_date) AS expiry_date
          FROM public.wms_receiving_lines rl
         WHERE rl.product_id = q.product_id AND rl.lot_number IS NOT DISTINCT FROM q.lot_number
      ) sl ON true
     WHERE q.quantity > 0
       AND sl.expiry_date IS NOT NULL AND sl.expiry_date < current_date
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
     LIMIT 200
  LOOP
    PERFORM public.wms_raise_exception(
      p_warehouse_id => r.warehouse_id, p_kind => 'expired_stock',
      p_reason => format('Lot %s expired %s and is still on hand (%s)',
                          COALESCE(r.lot_number,'—'), r.expiry_date, r.quantity),
      p_aggregate_type => 'stock_quant', p_aggregate_id => r.id,
      p_details => jsonb_build_object('product_id', r.product_id, 'location_id', r.location_id,
                                      'lot_number', r.lot_number, 'quantity', r.quantity,
                                      'expiry_date', r.expiry_date),
      p_idempotency_key => 'wms.exception:expired_stock:stock_quant:' || r.id::text,
      p_links => jsonb_build_array(jsonb_build_object('link_type','product','record_id', r.product_id))
    );
    v_n := v_n + 1;
  END LOOP;

  -- Warehouse devices reporting offline / erroring. Each device is
  -- attributed to a single deterministic warehouse in its business.
  FOR r IN
    SELECT d.id, d.display_name, d.role, d.status, d.last_error, w.warehouse_id
      FROM public.device_assignments d
      JOIN LATERAL (
        SELECT w2.id AS warehouse_id
          FROM public.warehouses w2
         WHERE w2.business_id = d.business_id
           AND (p_warehouse_id IS NULL OR w2.id = p_warehouse_id)
         ORDER BY w2.created_at, w2.id
         LIMIT 1
      ) w ON true
     WHERE d.enabled
       AND (d.status IN ('offline','error') OR d.last_seen_at < now() - interval '2 hours')
     LIMIT 200
  LOOP
    PERFORM public.wms_raise_exception(
      p_warehouse_id => r.warehouse_id,
      p_kind => CASE
                  WHEN r.role ILIKE '%print%' OR r.role ILIKE '%label%' THEN 'printer_offline'::public.wms_exception_kind
                  WHEN r.role ILIKE '%scan%' THEN 'scanner_offline'::public.wms_exception_kind
                  WHEN r.role ILIKE '%scale%' THEN 'scale_failure'::public.wms_exception_kind
                  ELSE 'device_offline'::public.wms_exception_kind
                END,
      p_reason => format('%s (%s) is %s', COALESCE(r.display_name,'Device'), r.role, COALESCE(r.status,'unreachable')),
      p_aggregate_type => 'device_assignment', p_aggregate_id => r.id,
      p_source_system => 'hardware',
      p_details => jsonb_build_object('device_role', r.role, 'status', r.status, 'last_error', r.last_error),
      p_idempotency_key => 'wms.exception:device_offline:device_assignment:' || r.id::text
    );
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_detect_operational_exceptions(uuid) TO authenticated, service_role;
