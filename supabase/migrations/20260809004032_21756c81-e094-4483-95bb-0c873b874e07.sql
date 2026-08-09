-- ============================================================
-- Phase 1 · Sales Order governance hardening
-- ============================================================

-- 1. Status vocabulary: admit the approval states the app already writes.
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_status_check
  CHECK (status = ANY (ARRAY[
    'draft','pending_approval','approved','rejected',
    'confirmed','processing','partial','fulfilled','invoiced','cancelled'
  ]));

-- 2. Unique order numbers per organization.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_org_number_uniq
  ON public.sales_orders (organization_id, so_number);

-- 3. Forecast revenue: use the real status vocabulary.
CREATE OR REPLACE FUNCTION public.trg_sales_order_to_revenue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_has_line_proj boolean;
  v_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_revenue_entries
      WHERE source_type='sales_order' AND source_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Forecast/commitment posting only. Once status reaches 'invoiced', the
  -- invoice-side trigger owns realized revenue and we clear forecast rows.
  v_active := NEW.status::text IN ('confirmed','processing','partial','fulfilled');

  DELETE FROM public.project_revenue_entries
    WHERE source_type='sales_order' AND source_id = NEW.id;

  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sales_order_items
     WHERE sales_order_id = NEW.id AND project_id IS NOT NULL
  ) INTO v_has_line_proj;

  IF v_has_line_proj THEN
    INSERT INTO public.project_revenue_entries
      (project_id, organization_id, business_id, source_type, source_id,
       milestone_id, amount, currency, posted_at, description)
    SELECT
      soi.project_id, NEW.organization_id, NEW.business_id,
      'sales_order', NEW.id, NULL,
      SUM(COALESCE(soi.line_total,0)), NEW.currency, NEW.created_at,
      'Sales order (line-tagged, forecast)'
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = NEW.id
      AND soi.project_id IS NOT NULL
    GROUP BY soi.project_id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    PERFORM public.upsert_project_revenue(
      NEW.project_id, NEW.organization_id, NEW.business_id,
      'sales_order', NEW.id, NULL,
      COALESCE(NEW.total, NEW.subtotal, 0), NEW.currency, NEW.created_at,
      'Sales order (commitment, forecast)'
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- 4. Reservation release: stock_reservations has no `status` column; the
--    open-ness predicate is `released_at IS NULL`.
CREATE OR REPLACE FUNCTION public.release_sales_order_reservations_atomic(p_so_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_count  int := 0;
  v_res    RECORD;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.sales_orders WHERE id = p_so_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  FOR v_res IN
    SELECT id FROM public.stock_reservations
     WHERE organization_id = v_org_id
       AND source_type = 'sales_order'
       AND source_id = p_so_id
       AND released_at IS NULL
  LOOP
    PERFORM public.release_stock_reservation(v_org_id, v_res.id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'released', v_count);
END;
$function$;

-- 5. Post-invoice lock must fire on BOTH invoicing routes.
--    (a) order-based: converted_invoice_id set on the SO (existing trigger)
--    (b) delivery-based: a delivery note for the SO spawns an invoice
CREATE OR REPLACE FUNCTION public.lock_sales_order_on_dn_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.spawned_invoice_id IS NOT NULL
     AND (OLD.spawned_invoice_id IS NULL OR OLD.spawned_invoice_id <> NEW.spawned_invoice_id)
     AND NEW.sales_order_id IS NOT NULL
     AND COALESCE(NEW.is_return, false) = false THEN
    UPDATE public.sales_orders
       SET is_locked = true, updated_at = now()
     WHERE id = NEW.sales_order_id
       AND is_locked = false;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lock_so_on_dn_invoice ON public.delivery_notes;
CREATE TRIGGER trg_lock_so_on_dn_invoice
  AFTER INSERT OR UPDATE OF spawned_invoice_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.lock_sales_order_on_dn_invoice();

-- 6. Cancellation as a compensating business event.
CREATE OR REPLACE FUNCTION public.cancel_sales_order_atomic(
  p_so_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so            RECORD;
  v_released      jsonb;
  v_dn            RECORD;
  v_dn_cancelled  int := 0;
  v_active_wave   text;
  v_invoiced_cnt  int;
BEGIN
  IF auth.uid() IS NULL AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found', p_so_id USING ERRCODE = 'P0002';
  END IF;

  IF v_so.business_id IS NULL OR NOT public.user_can_access_business(p_user_id, v_so.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_so.business_id USING ERRCODE = '42501';
  END IF;

  IF v_so.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true, 'sales_order_id', p_so_id);
  END IF;

  IF v_so.status NOT IN ('draft','pending_approval','approved','rejected','confirmed','processing','partial') THEN
    RAISE EXCEPTION 'Cannot cancel sales order % in status % — fulfilled or invoiced orders must be credited, not cancelled.',
      v_so.so_number, v_so.status USING ERRCODE = '22023';
  END IF;

  -- Never cancel commercially realised work: any invoice on either route blocks.
  IF v_so.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % is already invoiced — raise a credit note instead of cancelling.', v_so.so_number
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_invoiced_cnt
    FROM public.delivery_notes
   WHERE sales_order_id = p_so_id AND spawned_invoice_id IS NOT NULL;
  IF v_invoiced_cnt > 0 THEN
    RAISE EXCEPTION 'Sales order % has % invoice(s) raised from its deliveries — raise a credit note instead of cancelling.',
      v_so.so_number, v_invoiced_cnt USING ERRCODE = '22023';
  END IF;

  -- Delivered goods are physical history; they cannot be cancelled away.
  IF EXISTS (
    SELECT 1 FROM public.sales_order_items
     WHERE sales_order_id = p_so_id AND COALESCE(quantity_fulfilled,0) > 0
  ) THEN
    RAISE EXCEPTION 'Sales order % has delivered quantities — process a return before cancelling.', v_so.so_number
      USING ERRCODE = '22023';
  END IF;

  -- An order inside a live picking wave must be removed from it first.
  SELECT w.wave_number INTO v_active_wave
    FROM public.wms_pick_wave_lines wl
    JOIN public.wms_pick_waves w ON w.id = wl.wave_id
   WHERE wl.sales_order_id = p_so_id
     AND w.state NOT IN ('completed','cancelled')
   LIMIT 1;
  IF v_active_wave IS NOT NULL THEN
    RAISE EXCEPTION 'Sales order % is on active pick wave % — cancel or complete that wave first.',
      v_so.so_number, v_active_wave USING ERRCODE = '22023';
  END IF;

  -- Compensate downstream commitments.
  v_released := public.release_sales_order_reservations_atomic(p_so_id);

  PERFORM public._wms_crossdock_break_for_demand_doc(
    p_so_id, 'sales order ' || v_so.so_number || ' cancelled');

  FOR v_dn IN
    SELECT id FROM public.delivery_notes
     WHERE sales_order_id = p_so_id
       AND status IN ('pending','ready_to_dispatch')
  LOOP
    PERFORM public.cancel_delivery_atomic(
      v_dn.id, p_user_id,
      'Sales order ' || v_so.so_number || ' cancelled');
    v_dn_cancelled := v_dn_cancelled + 1;
  END LOOP;

  UPDATE public.backorders
     SET status = 'cancelled'
   WHERE sales_order_id = p_so_id
     AND status IN ('pending','allocated');

  UPDATE public.sales_orders
     SET status = 'cancelled', updated_at = now()
   WHERE id = p_so_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action,
    entity_type, entity_id, entity_name, changes_summary, new_values
  ) VALUES (
    v_so.organization_id, v_so.business_id, p_user_id, 'cancel',
    'sales_order', p_so_id, v_so.so_number,
    'Sales order cancelled' || COALESCE(' — ' || NULLIF(btrim(p_reason), ''), ''),
    jsonb_build_object(
      'from_status', v_so.status,
      'to_status', 'cancelled',
      'reason', NULLIF(btrim(p_reason), ''),
      'reservations_released', v_released->'released',
      'delivery_notes_cancelled', v_dn_cancelled
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'sales_order_id', p_so_id,
    'so_number', v_so.so_number,
    'reservations_released', COALESCE((v_released->>'released')::int, 0),
    'delivery_notes_cancelled', v_dn_cancelled
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cancel_sales_order_atomic(uuid, uuid, text) TO authenticated;

-- 7. confirm_sales_order_atomic: 'approved' is now a real, reachable state.
COMMENT ON FUNCTION public.confirm_sales_order_atomic(uuid, uuid) IS
  'Confirms a draft/approved sales order and creates per-line stock reservations. Callable states are draft and approved (approved is now a legal status as of Phase 1).';
