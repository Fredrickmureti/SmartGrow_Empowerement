-- =====================================================================
-- Phase 2 — detection at source.
-- Every detector is failure-isolated: an exception in the exception
-- service must never block a physical warehouse action.
-- =====================================================================

-- ---------------------------------------------------- 1. receiving
CREATE OR REPLACE FUNCTION public._wms_detect_receiving_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_delta numeric;
BEGIN
  BEGIN
    IF NEW.received_qty IS NULL THEN RETURN NEW; END IF;

    IF COALESCE(NEW.damaged_qty,0) > 0
       AND (TG_OP = 'INSERT' OR COALESCE(OLD.damaged_qty,0) <> COALESCE(NEW.damaged_qty,0)) THEN
      PERFORM public.wms_raise_exception(
        p_warehouse_id => NEW.warehouse_id,
        p_kind => 'damaged_goods',
        p_reason => format('%s damaged unit(s) recorded on receiving line', NEW.damaged_qty),
        p_aggregate_type => 'wms_receiving_line',
        p_aggregate_id => NEW.id,
        p_lpn_id => NEW.lpn_id,
        p_details => jsonb_build_object('product_id', NEW.product_id, 'lot_number', NEW.lot_number,
                                        'damaged_qty', NEW.damaged_qty, 'received_qty', NEW.received_qty),
        p_idempotency_key => 'wms.exception:damaged_goods:wms_receiving_line:' || NEW.id::text,
        p_links => jsonb_build_array(jsonb_build_object(
          'link_type','receiving_session','record_id', NEW.session_id,
          'route_path','/warehouse-app/receiving/' || NEW.session_id::text))
      );
    END IF;

    IF NEW.expected_qty IS NULL OR NEW.expected_qty = 0 THEN RETURN NEW; END IF;
    v_delta := NEW.received_qty - NEW.expected_qty;
    IF v_delta = 0 THEN RETURN NEW; END IF;

    PERFORM public.wms_raise_exception(
      p_warehouse_id => NEW.warehouse_id,
      p_kind => CASE WHEN v_delta > 0 THEN 'over_receipt'::public.wms_exception_kind
                     ELSE 'under_receipt'::public.wms_exception_kind END,
      p_reason => format('Expected %s, received %s (%s%s)',
                          NEW.expected_qty, NEW.received_qty,
                          CASE WHEN v_delta > 0 THEN '+' ELSE '' END, v_delta),
      p_aggregate_type => 'wms_receiving_line',
      p_aggregate_id => NEW.id,
      p_lpn_id => NEW.lpn_id,
      p_details => jsonb_build_object('product_id', NEW.product_id, 'lot_number', NEW.lot_number,
                                      'expected_qty', NEW.expected_qty, 'received_qty', NEW.received_qty,
                                      'variance', v_delta, 'uom', NEW.uom,
                                      'discrepancy_reason', NEW.discrepancy_reason),
      p_idempotency_key => 'wms.exception:receipt_variance:wms_receiving_line:' || NEW.id::text,
      p_links => jsonb_build_array(
        jsonb_build_object('link_type','receiving_session','record_id', NEW.session_id,
                           'route_path','/warehouse-app/receiving/' || NEW.session_id::text),
        jsonb_build_object('link_type','product','record_id', NEW.product_id))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_receiving_lines %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_receiving_lines_detect_exception ON public.wms_receiving_lines;
CREATE TRIGGER wms_receiving_lines_detect_exception
  AFTER INSERT OR UPDATE OF received_qty, damaged_qty, expected_qty
  ON public.wms_receiving_lines
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_receiving_exception();

-- ---------------------------------------------------------- 2. quality
CREATE OR REPLACE FUNCTION public._wms_detect_qc_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NEW.state IN ('rejected','partially_accepted') THEN
      PERFORM public.wms_raise_exception(
        p_warehouse_id => NEW.warehouse_id,
        p_kind => 'qc_fail',
        p_reason => format('QC %s — %s of %s rejected',
                            replace(NEW.state,'_',' '), COALESCE(NEW.rejected_qty,0), NEW.quantity),
        p_aggregate_type => 'wms_qc_inspection',
        p_aggregate_id => NEW.id,
        p_severity => CASE WHEN NEW.state = 'rejected' THEN 4::smallint ELSE 3::smallint END,
        p_details => jsonb_build_object('product_id', NEW.product_id, 'lot_number', NEW.lot_number,
                                        'quantity', NEW.quantity, 'accepted_qty', NEW.accepted_qty,
                                        'rejected_qty', NEW.rejected_qty, 'disposition', NEW.disposition,
                                        'source_doc_type', NEW.source_doc_type,
                                        'source_doc_id', NEW.source_doc_id),
        p_idempotency_key => 'wms.exception:qc_fail:wms_qc_inspection:' || NEW.id::text,
        p_links => jsonb_build_array(
          jsonb_build_object('link_type','qc_inspection','record_id', NEW.id,
                             'route_path','/warehouse-app/qc/' || NEW.id::text),
          jsonb_build_object('link_type','product','record_id', NEW.product_id))
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_qc_inspections %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_qc_inspections_detect_exception ON public.wms_qc_inspections;
CREATE TRIGGER wms_qc_inspections_detect_exception
  AFTER UPDATE OF state ON public.wms_qc_inspections
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_qc_exception();

-- ------------------------------------------------------- 3. counting
CREATE OR REPLACE FUNCTION public._wms_detect_count_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_wh uuid; v_prior integer;
BEGIN
  BEGIN
    IF NEW.counted_qty IS NULL OR COALESCE(NEW.variance_qty,0) = 0 THEN RETURN NEW; END IF;
    IF COALESCE(NEW.tolerance_outcome,'') = 'within_tolerance' THEN RETURN NEW; END IF;

    SELECT warehouse_id INTO v_wh FROM public.wms_count_sessions WHERE id = NEW.session_id;
    IF v_wh IS NULL THEN RETURN NEW; END IF;

    -- Recurrence: same product + location already varied recently.
    SELECT count(*) INTO v_prior
      FROM public.wms_exceptions
     WHERE kind IN ('count_variance','repeated_discrepancy')
       AND aggregate_type = 'wms_count_line'
       AND details->>'product_id' = NEW.product_id::text
       AND details->>'location_id' = NEW.location_id::text
       AND created_at > now() - interval '90 days';

    PERFORM public.wms_raise_exception(
      p_warehouse_id => v_wh,
      p_kind => CASE WHEN v_prior >= 2 THEN 'repeated_discrepancy'::public.wms_exception_kind
                     ELSE 'count_variance'::public.wms_exception_kind END,
      p_reason => format('Count variance %s (system %s, counted %s)',
                          NEW.variance_qty, NEW.system_qty, NEW.counted_qty),
      p_aggregate_type => 'wms_count_line',
      p_aggregate_id => NEW.id,
      p_details => jsonb_build_object('product_id', NEW.product_id, 'location_id', NEW.location_id,
                                      'lot_number', NEW.lot_number, 'system_qty', NEW.system_qty,
                                      'counted_qty', NEW.counted_qty, 'variance_qty', NEW.variance_qty,
                                      'prior_occurrences', v_prior,
                                      'tolerance_outcome', NEW.tolerance_outcome),
      p_idempotency_key => 'wms.exception:count_variance:wms_count_line:' || NEW.id::text,
      p_links => jsonb_build_array(
        jsonb_build_object('link_type','count_session','record_id', NEW.session_id,
                           'route_path','/warehouse-app/counts/' || NEW.session_id::text),
        jsonb_build_object('link_type','product','record_id', NEW.product_id))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_count_lines %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_count_lines_detect_exception ON public.wms_count_lines;
CREATE TRIGGER wms_count_lines_detect_exception
  AFTER INSERT OR UPDATE OF counted_qty, variance_qty, tolerance_outcome
  ON public.wms_count_lines
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_count_exception();

-- ------------------------------------------------ 4. tasks and labour
CREATE OR REPLACE FUNCTION public._wms_detect_task_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    IF NEW.state::text = 'exception' AND OLD.state::text IS DISTINCT FROM 'exception' THEN
      PERFORM public.wms_raise_exception(
        p_warehouse_id => NEW.warehouse_id,
        p_kind => 'abandoned_task',
        p_reason => COALESCE(NULLIF(NEW.cancel_reason,''),
                             format('%s task blocked', replace(NEW.task_type::text,'_',' '))),
        p_aggregate_type => 'wms_task',
        p_aggregate_id => NEW.id,
        p_task_id => NEW.id,
        p_lpn_id => NEW.lpn_id,
        p_details => jsonb_build_object('task_type', NEW.task_type, 'priority', NEW.priority,
                                        'assignee_user_id', NEW.assignee_user_id,
                                        'product_id', NEW.product_id, 'quantity', NEW.quantity,
                                        'source_doc_type', NEW.source_doc_type,
                                        'source_doc_id', NEW.source_doc_id),
        p_idempotency_key => 'wms.exception:abandoned_task:wms_task:' || NEW.id::text,
        p_links => jsonb_build_array(jsonb_build_object(
          'link_type','task','record_id', NEW.id, 'route_path','/warehouse-app/tasks'))
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_tasks %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_tasks_detect_exception ON public.wms_tasks;
CREATE TRIGGER wms_tasks_detect_exception
  AFTER UPDATE OF state ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_task_exception();

-- ------------------------------------------------ 5. quarantined LPNs
CREATE OR REPLACE FUNCTION public._wms_detect_lpn_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    IF NEW.status::text = 'quarantined' AND OLD.status::text IS DISTINCT FROM 'quarantined' THEN
      PERFORM public.wms_raise_exception(
        p_warehouse_id => NEW.warehouse_id,
        p_kind => 'damaged_lpn',
        p_reason => COALESCE(NULLIF(NEW.notes,''), format('Licence plate %s quarantined', NEW.code)),
        p_aggregate_type => 'wms_license_plate',
        p_aggregate_id => NEW.id,
        p_lpn_id => NEW.id,
        p_details => jsonb_build_object('code', NEW.code, 'lpn_type', NEW.lpn_type,
                                        'location_id', NEW.current_location_id),
        p_idempotency_key => 'wms.exception:damaged_lpn:wms_license_plate:' || NEW.id::text || ':' || NEW.row_version::text,
        p_links => jsonb_build_array(jsonb_build_object(
          'link_type','license_plate','record_id', NEW.id, 'record_label', NEW.code,
          'route_path','/warehouse-app/license-plates/' || NEW.id::text))
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_license_plates %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_license_plates_detect_exception ON public.wms_license_plates;
CREATE TRIGGER wms_license_plates_detect_exception
  AFTER UPDATE OF status ON public.wms_license_plates
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_lpn_exception();

-- --------------------------------------------------------- 6. returns
CREATE OR REPLACE FUNCTION public._wms_detect_return_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_delta numeric;
BEGIN
  BEGIN
    IF NEW.received_qty IS NULL THEN RETURN NEW; END IF;
    v_delta := NEW.received_qty - COALESCE(NEW.expected_qty, NEW.received_qty);
    IF v_delta = 0 AND COALESCE(NEW.scrap_qty,0) = 0 AND COALESCE(NEW.quarantine_qty,0) = 0 THEN
      RETURN NEW;
    END IF;

    PERFORM public.wms_raise_exception(
      p_warehouse_id => NEW.warehouse_id,
      p_kind => 'return_discrepancy',
      p_reason => format('Return line variance %s (scrap %s, quarantine %s)',
                          v_delta, COALESCE(NEW.scrap_qty,0), COALESCE(NEW.quarantine_qty,0)),
      p_aggregate_type => 'wms_return_line',
      p_aggregate_id => NEW.id,
      p_lpn_id => NEW.lpn_id,
      p_details => jsonb_build_object('product_id', NEW.product_id, 'expected_qty', NEW.expected_qty,
                                      'received_qty', NEW.received_qty, 'variance', v_delta,
                                      'scrap_qty', NEW.scrap_qty, 'quarantine_qty', NEW.quarantine_qty,
                                      'disposition', NEW.disposition, 'condition_code', NEW.condition_code),
      p_idempotency_key => 'wms.exception:return_discrepancy:wms_return_line:' || NEW.id::text,
      p_links => jsonb_build_array(jsonb_build_object(
        'link_type','return_order','record_id', NEW.return_order_id,
        'route_path','/warehouse-app/returns/' || NEW.return_order_id::text))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_return_lines %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_return_lines_detect_exception ON public.wms_return_lines;
CREATE TRIGGER wms_return_lines_detect_exception
  AFTER INSERT OR UPDATE OF received_qty, scrap_qty, quarantine_qty, disposition
  ON public.wms_return_lines
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_return_exception();

-- ---------------------------------------------- 7. negative inventory
CREATE OR REPLACE FUNCTION public._wms_detect_inventory_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_wh uuid;
BEGIN
  BEGIN
    IF COALESCE(NEW.quantity,0) >= 0 THEN RETURN NEW; END IF;
    SELECT warehouse_id INTO v_wh FROM public.stock_locations WHERE id = NEW.location_id;
    IF v_wh IS NULL THEN RETURN NEW; END IF;

    PERFORM public.wms_raise_exception(
      p_warehouse_id => v_wh,
      p_kind => 'negative_inventory',
      p_reason => format('Negative on-hand (%s) detected at location', NEW.quantity),
      p_aggregate_type => 'stock_quant',
      p_aggregate_id => NEW.id,
      p_lpn_id => NEW.lpn_id,
      p_details => jsonb_build_object('product_id', NEW.product_id, 'location_id', NEW.location_id,
                                      'lot_number', NEW.lot_number, 'quantity', NEW.quantity),
      p_idempotency_key => 'wms.exception:negative_inventory:stock_quant:' || NEW.id::text,
      p_links => jsonb_build_array(
        jsonb_build_object('link_type','product','record_id', NEW.product_id),
        jsonb_build_object('link_type','warehouse_location','record_id', NEW.location_id))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on stock_quants %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_quants_detect_exception ON public.stock_quants;
CREATE TRIGGER stock_quants_detect_exception
  AFTER INSERT OR UPDATE OF quantity ON public.stock_quants
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_inventory_exception();

-- ------------------------------------------------------------ 8. dock
CREATE OR REPLACE FUNCTION public._wms_detect_dock_exception()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('no_show','expired','missed') THEN
      PERFORM public.wms_raise_exception(
        p_warehouse_id => NEW.warehouse_id,
        p_kind => 'missed_appointment',
        p_reason => format('Dock appointment %s marked %s',
                            COALESCE(NEW.appointment_no, NEW.reference, ''), NEW.state),
        p_aggregate_type => 'wms_dock_appointment',
        p_aggregate_id => NEW.id,
        p_details => jsonb_build_object('carrier_id', NEW.carrier_id, 'dock_id', NEW.dock_id,
                                        'window_start', NEW.window_start, 'window_end', NEW.window_end,
                                        'trailer_ref', NEW.trailer_ref),
        p_idempotency_key => 'wms.exception:missed_appointment:wms_dock_appointment:' || NEW.id::text,
        p_links => jsonb_build_array(
          jsonb_build_object('link_type','dock_appointment','record_id', NEW.id,
                             'route_path','/warehouse-app/dock'),
          jsonb_build_object('link_type','carrier','record_id', NEW.carrier_id))
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception detection failed on wms_dock_appointments %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_dock_appointments_detect_exception ON public.wms_dock_appointments;
CREATE TRIGGER wms_dock_appointments_detect_exception
  AFTER UPDATE OF state ON public.wms_dock_appointments
  FOR EACH ROW EXECUTE FUNCTION public._wms_detect_dock_exception();

-- ============================================================
-- 9. Periodic sweep — divergences no single write reveals.
-- ============================================================
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

  -- Warehouse devices reporting offline / erroring.
  FOR r IN
    SELECT d.id, d.display_name, d.role, d.status, d.last_error, w.id AS warehouse_id
      FROM public.device_assignments d
      JOIN public.warehouses w ON w.business_id = d.business_id
     WHERE d.enabled
       AND (d.status IN ('offline','error') OR d.last_seen_at < now() - interval '2 hours')
       AND (p_warehouse_id IS NULL OR w.id = p_warehouse_id)
       AND (p_warehouse_id IS NOT NULL OR w.id = (
             SELECT min(w2.id) FROM public.warehouses w2 WHERE w2.business_id = d.business_id))
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
