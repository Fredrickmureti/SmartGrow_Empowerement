-- ============================================================
-- Cross-dock Phase 4 — exception handling & requalification
-- ============================================================

-- Internal break: same effects as wms_crossdock_break but callable from
-- triggers/cron where there is no auth.uid() and no row_version.
CREATE OR REPLACE FUNCTION public._wms_crossdock_auto_break(
  p_opportunity_id uuid, p_reason text, p_terminal public.wms_crossdock_state DEFAULT 'broken'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_row FROM public.wms_crossdock_opportunities
   WHERE id = p_opportunity_id
     AND state IN ('detected','qualified','approved','staging','staged','loaded')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.wms_tasks
     SET state = 'cancelled'::wms_task_state,
         cancel_reason = COALESCE(p_reason, 'cross-dock broken')
   WHERE id IN (v_row.stage_task_id, v_row.load_task_id)
     AND state NOT IN ('completed','done','cancelled');

  UPDATE public.wms_crossdock_opportunities
     SET state = p_terminal,
         break_reason = CASE WHEN p_terminal = 'broken' THEN p_reason ELSE break_reason END,
         reject_reason = CASE WHEN p_terminal = 'rejected' THEN p_reason ELSE reject_reason END
   WHERE id = p_opportunity_id
   RETURNING * INTO v_row;

  IF p_terminal = 'broken' THEN
    BEGIN
      PERFORM public.wms_raise_exception(
        v_row.warehouse_id, 'other'::wms_exception_kind,
        'Cross-dock broken: ' || COALESCE(p_reason, 'demand or supply changed'),
        'wms_crossdock_opportunity', v_row.id, NULL, NULL, 2::smallint,
        jsonb_build_object('product_id', v_row.product_id, 'quantity', v_row.quantity,
                           'demand_type', v_row.demand_type, 'demand_doc_id', v_row.demand_doc_id,
                           'auto', true)
      );
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock exception raise failed: %', SQLERRM;
    END;
  END IF;

  PERFORM public.emit_crossdock_event(
    CASE WHEN p_terminal = 'broken' THEN 'warehouse.crossdock.broken'
         WHEN p_terminal = 'expired' THEN 'warehouse.crossdock.expired'
         ELSE 'warehouse.crossdock.rejected' END, v_row);
END $$;

REVOKE ALL ON FUNCTION public._wms_crossdock_auto_break(uuid, text, public.wms_crossdock_state) FROM public, anon, authenticated;

-- Break every live opportunity attached to a demand document -------------
CREATE OR REPLACE FUNCTION public._wms_crossdock_break_for_demand_doc(
  p_doc_id uuid, p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM public.wms_crossdock_opportunities
     WHERE (demand_doc_id = p_doc_id OR sales_order_id = p_doc_id)
       AND state IN ('detected','qualified','approved','staging','staged','loaded')
  LOOP
    PERFORM public._wms_crossdock_auto_break(r.id, p_reason);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public._wms_crossdock_break_for_demand_doc(uuid, text) FROM public, anon, authenticated;

-- 1. Sales order cancelled ----------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_sales_order_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    IF NEW.status = 'cancelled' AND COALESCE(OLD.status::text,'') <> 'cancelled' THEN
      PERFORM public._wms_crossdock_break_for_demand_doc(NEW.id, 'Sales order cancelled');
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock so-cancel hook failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_sales_order_change ON public.sales_orders;
CREATE TRIGGER trg_wms_crossdock_on_sales_order_change
AFTER UPDATE OF status ON public.sales_orders
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_sales_order_change();

-- 2. Sales order line shrunk or deleted ---------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_sales_order_item_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record; v_line uuid; v_outstanding numeric;
BEGIN
  BEGIN
    v_line := COALESCE(OLD.id, NEW.id);
    IF TG_OP = 'DELETE' THEN
      v_outstanding := 0;
    ELSE
      v_outstanding := GREATEST(COALESCE(NEW.quantity,0) - COALESCE(NEW.quantity_fulfilled,0), 0);
    END IF;

    FOR r IN
      SELECT id, quantity FROM public.wms_crossdock_opportunities
       WHERE (demand_line_id = v_line OR sales_order_item_id = v_line)
         AND state IN ('detected','qualified','approved','staging','staged')
    LOOP
      IF v_outstanding <= 0 THEN
        PERFORM public._wms_crossdock_auto_break(r.id,
          CASE WHEN TG_OP = 'DELETE' THEN 'Demand line removed'
               ELSE 'Demand line already fulfilled elsewhere' END);
      ELSIF v_outstanding < r.quantity THEN
        PERFORM public._wms_crossdock_auto_break(r.id,
          format('Demand reduced to %s (plan was %s)', v_outstanding, r.quantity));
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock so-item hook failed: %', SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_sales_order_item_change ON public.sales_order_items;
CREATE TRIGGER trg_wms_crossdock_on_sales_order_item_change
AFTER UPDATE OR DELETE ON public.sales_order_items
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_sales_order_item_change();

-- 3. Transfer cancelled --------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_transfer_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    IF NEW.status = 'cancelled' AND COALESCE(OLD.status,'') <> 'cancelled' THEN
      PERFORM public._wms_crossdock_break_for_demand_doc(NEW.id, 'Transfer cancelled');
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock transfer hook failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_transfer_change ON public.stock_transfers;
CREATE TRIGGER trg_wms_crossdock_on_transfer_change
AFTER UPDATE OF status ON public.stock_transfers
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_transfer_change();

-- 4. QC inspection failed after detection --------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_qc_result()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record;
BEGIN
  BEGIN
    IF NEW.state IN ('failed','conditional') AND COALESCE(OLD.state::text,'') <> NEW.state::text THEN
      FOR r IN
        SELECT id FROM public.wms_crossdock_opportunities
         WHERE state IN ('detected','qualified','approved','staging','staged')
           AND product_id = NEW.product_id
           AND warehouse_id = NEW.warehouse_id
           AND (grn_line_id = NEW.source_doc_id
                OR receiving_line_id = NEW.source_doc_id
                OR grn_id = NEW.source_doc_id)
      LOOP
        PERFORM public._wms_crossdock_auto_break(r.id,
          'Quality inspection ' || NEW.state::text || ' — goods cannot flow through');
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock qc hook failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_qc_result ON public.wms_qc_inspections;
CREATE TRIGGER trg_wms_crossdock_on_qc_result
AFTER UPDATE OF state ON public.wms_qc_inspections
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_qc_result();

-- 5. Dock appointment cancelled -----------------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_appointment_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record;
BEGIN
  BEGIN
    IF NEW.state::text IN ('cancelled','no_show') AND COALESCE(OLD.state::text,'') <> NEW.state::text THEN
      FOR r IN
        SELECT id FROM public.wms_crossdock_opportunities
         WHERE appointment_id = NEW.id
           AND state IN ('approved','staging','staged')
      LOOP
        PERFORM public._wms_crossdock_auto_break(r.id,
          'Outbound appointment ' || NEW.state::text);
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock appointment hook failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_appointment_change ON public.wms_dock_appointments;
CREATE TRIGGER trg_wms_crossdock_on_appointment_change
AFTER UPDATE OF state ON public.wms_dock_appointments
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_appointment_change();

-- 6. Dock deactivated ----------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_dock_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record;
BEGIN
  BEGIN
    IF OLD.is_active AND NOT NEW.is_active THEN
      FOR r IN
        SELECT id FROM public.wms_crossdock_opportunities
         WHERE outbound_dock_id = NEW.id
           AND state IN ('approved','staging','staged')
      LOOP
        PERFORM public._wms_crossdock_auto_break(r.id, 'Outbound dock taken out of service');
        UPDATE public.wms_crossdock_opportunities SET outbound_dock_id = NULL WHERE id = r.id;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'crossdock dock hook failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_dock_change ON public.warehouse_docks;
CREATE TRIGGER trg_wms_crossdock_on_dock_change
AFTER UPDATE OF is_active ON public.warehouse_docks
FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_dock_change();

-- 7. Requalification sweep ----------------------------------------------
CREATE OR REPLACE FUNCTION public.wms_crossdock_requalify_sweep()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record; v_out numeric; v_count integer := 0;
BEGIN
  FOR r IN
    SELECT o.* FROM public.wms_crossdock_opportunities o
     WHERE o.state IN ('detected','qualified','approved','staging','staged')
  LOOP
    -- expire past the carrier cut-off before anything else
    IF r.expires_at IS NOT NULL AND r.expires_at < now()
       AND r.state IN ('detected','qualified') THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Carrier cut-off passed', 'expired');
      v_count := v_count + 1;
      CONTINUE;
    END IF;

    v_out := NULL;
    IF COALESCE(r.demand_type, 'sales_order') = 'sales_order' THEN
      SELECT GREATEST(COALESCE(si.quantity,0) - COALESCE(si.quantity_fulfilled,0), 0)
        INTO v_out
        FROM public.sales_order_items si
        JOIN public.sales_orders so ON so.id = si.sales_order_id
       WHERE si.id = COALESCE(r.demand_line_id, r.sales_order_item_id)
         AND so.status <> 'cancelled';
    ELSIF r.demand_type = 'transfer' THEN
      SELECT GREATEST(COALESCE(ti.quantity_requested,0) - COALESCE(ti.quantity_received,0), 0)
        INTO v_out
        FROM public.stock_transfer_items ti
        JOIN public.stock_transfers t ON t.id = ti.transfer_id
       WHERE ti.id = r.demand_line_id
         AND t.status <> 'cancelled';
    END IF;

    IF v_out IS NULL THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Demand document no longer available');
      v_count := v_count + 1;
    ELSIF v_out <= 0 THEN
      PERFORM public._wms_crossdock_auto_break(r.id, 'Demand already fulfilled elsewhere');
      v_count := v_count + 1;
    ELSIF v_out < r.quantity THEN
      PERFORM public._wms_crossdock_auto_break(r.id,
        format('Demand reduced to %s (plan was %s)', v_out, r.quantity));
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.wms_crossdock_requalify_sweep() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.wms_crossdock_requalify_sweep() TO authenticated, service_role;

SELECT cron.unschedule('wms-crossdock-requalify-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wms-crossdock-requalify-sweep');

SELECT cron.schedule('wms-crossdock-requalify-sweep', '*/15 * * * *',
  $cron$ SELECT public.wms_crossdock_requalify_sweep(); $cron$);
