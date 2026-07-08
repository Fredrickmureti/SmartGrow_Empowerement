-- Extend source_type check
ALTER TABLE public.stock_reservations
  DROP CONSTRAINT IF EXISTS stock_reservations_source_type_check;
ALTER TABLE public.stock_reservations
  ADD CONSTRAINT stock_reservations_source_type_check
  CHECK (source_type = ANY (ARRAY['pos','sales_order','transfer','manual','physical_count']));

-- Rewrite freeze to also create reservations
CREATE OR REPLACE FUNCTION public.physical_count_freeze(
  p_count_id uuid,
  p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_c RECORD; v_lines int := 0; v_reservations int := 0;
BEGIN
  SELECT * INTO v_c FROM public.physical_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_count_id USING ERRCODE='P0001'; END IF;
  IF v_c.state <> 'draft' THEN
    RAISE EXCEPTION 'cannot freeze count in state %', v_c.state USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.physical_count_lines (
    count_id, organization_id, business_id, product_id, system_qty_at_freeze,
    unit_cost_snapshot, cost_source
  )
  SELECT p_count_id, v_c.organization_id, v_c.business_id, p.id,
         COALESCE(ws.quantity, 0),
         COALESCE(ws.average_cost, p.cost_price, 0),
         'wac'
    FROM public.products p
    LEFT JOIN public.warehouse_stock ws
      ON ws.product_id = p.id AND ws.warehouse_id = v_c.warehouse_id
   WHERE p.organization_id = v_c.organization_id
     AND p.business_id = v_c.business_id
     AND p.track_inventory = true
     AND p.type = 'product'
  ON CONFLICT (count_id, product_id, packaging_id, lot_id) DO NOTHING;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  INSERT INTO public.physical_count_freeze_movements (
    count_id, organization_id, warehouse_id, product_id, last_movement_id
  )
  SELECT p_count_id, v_c.organization_id, v_c.warehouse_id, pcl.product_id,
         (SELECT id FROM public.stock_movements sm
           WHERE sm.warehouse_id = v_c.warehouse_id
             AND sm.product_id = pcl.product_id
           ORDER BY sm.created_at DESC LIMIT 1)
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
  ON CONFLICT (count_id, warehouse_id, product_id) DO NOTHING;

  INSERT INTO public.stock_reservations (
    organization_id, business_id, branch_id, warehouse_id,
    product_id, quantity, source_type, source_id, reserved_by, expires_at
  )
  SELECT v_c.organization_id, v_c.business_id, v_c.branch_id, v_c.warehouse_id,
         pcl.product_id, pcl.system_qty_at_freeze,
         'physical_count', p_count_id, p_user_id,
         now() + interval '24 hours'
    FROM public.physical_count_lines pcl
   WHERE pcl.count_id = p_count_id
     AND pcl.system_qty_at_freeze > 0;
  GET DIAGNOSTICS v_reservations = ROW_COUNT;

  UPDATE public.physical_counts
     SET state = 'counting', frozen_at = now(), frozen_by = p_user_id
   WHERE id = p_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_count_id, v_c.organization_id, 'frozen', p_user_id,
          jsonb_build_object('lines_snapshotted', v_lines, 'reservations_created', v_reservations));

  RETURN jsonb_build_object('success', true, 'lines_snapshotted', v_lines, 'reservations_created', v_reservations);
END $$;

CREATE OR REPLACE FUNCTION public._release_physical_count_reservations(p_count_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM public.stock_reservations
   WHERE source_type = 'physical_count' AND source_id = p_count_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public._physical_count_post_side_effects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_released int;
BEGIN
  IF NEW.state = 'posted' AND (OLD.state IS DISTINCT FROM 'posted') THEN
    v_released := public._release_physical_count_reservations(NEW.id);
    INSERT INTO public.business_event_outbox (
      organization_id, business_id, event_type, source_type, source_id, payload, status
    ) VALUES (
      NEW.organization_id, NEW.business_id, 'inventory.reorder.recompute',
      'physical_count', NEW.id,
      jsonb_build_object('warehouse_id', NEW.warehouse_id, 'count_id', NEW.id),
      'pending'
    );
    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (NEW.id, NEW.organization_id, 'reservations_released', NEW.posted_by,
            jsonb_build_object('released', v_released));
  ELSIF NEW.state = 'cancelled' AND (OLD.state IS DISTINCT FROM 'cancelled') THEN
    v_released := public._release_physical_count_reservations(NEW.id);
    INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
    VALUES (NEW.id, NEW.organization_id, 'reservations_released', NEW.cancelled_by,
            jsonb_build_object('released', v_released, 'reason', 'cancelled'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_physical_count_post_side_effects ON public.physical_counts;
CREATE TRIGGER trg_physical_count_post_side_effects
  AFTER UPDATE OF state ON public.physical_counts
  FOR EACH ROW EXECUTE FUNCTION public._physical_count_post_side_effects();

-- Reversal
CREATE OR REPLACE FUNCTION public.physical_count_supersede(
  p_source_count_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT 'Reversal'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_src RECORD; v_orig_adj_id uuid; v_new_adj_id uuid;
  v_orig_je uuid; v_new_je uuid; v_new_entry text;
  v_orig_line RECORD;
BEGIN
  SELECT * INTO v_src FROM public.physical_counts WHERE id = p_source_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'physical count % not found', p_source_count_id USING ERRCODE='P0001'; END IF;
  IF v_src.state <> 'posted' THEN
    RAISE EXCEPTION 'cannot supersede count in state % — only posted counts can be reversed', v_src.state
      USING ERRCODE='P0001';
  END IF;

  v_orig_adj_id := (v_src.posted_adjustment_ids)[1];
  v_orig_je := v_src.posted_journal_entry_id;

  INSERT INTO public.stock_adjustments (
    organization_id, business_id, branch_id, warehouse_id,
    adjustment_number, adjustment_date, reason, notes,
    status, created_by, approved_by, approved_at, allow_negative
  ) VALUES (
    v_src.organization_id, v_src.business_id, v_src.branch_id, v_src.warehouse_id,
    'PCADJ-REV-' || v_src.count_number, CURRENT_DATE,
    'Physical Count Reversal',
    'Reversal of ' || v_src.count_number || ' — ' || p_reason,
    'approved', p_user_id, p_user_id, now(), true
  ) RETURNING id INTO v_new_adj_id;

  FOR v_orig_line IN
    SELECT * FROM public.stock_adjustment_items WHERE adjustment_id = v_orig_adj_id
  LOOP
    INSERT INTO public.stock_adjustment_items (
      adjustment_id, product_id,
      quantity_before, quantity_adjustment, quantity_after,
      unit_cost, warehouse_id, branch_id, notes
    ) VALUES (
      v_new_adj_id, v_orig_line.product_id,
      v_orig_line.quantity_after,
      -v_orig_line.quantity_adjustment,
      v_orig_line.quantity_before,
      v_orig_line.unit_cost, v_src.warehouse_id, v_src.branch_id,
      'Reversal of physical count ' || v_src.count_number
    );

    INSERT INTO public.stock_movements (
      organization_id, business_id, branch_id, warehouse_id,
      product_id, movement_type, quantity, unit_cost,
      reference_type, reference_id, notes, created_by
    ) VALUES (
      v_src.organization_id, v_src.business_id, v_src.branch_id, v_src.warehouse_id,
      v_orig_line.product_id,
      CASE WHEN v_orig_line.quantity_adjustment > 0 THEN 'adjustment_out' ELSE 'adjustment_in' END,
      ABS(v_orig_line.quantity_adjustment), v_orig_line.unit_cost,
      'physical_count_reversal', p_source_count_id,
      'Reversal of physical count ' || v_src.count_number, p_user_id
    );
  END LOOP;

  IF v_orig_je IS NOT NULL THEN
    SELECT 'JE-' || LPAD((COALESCE(MAX(CAST(NULLIF(regexp_replace(entry_number,'\D','','g'),'') AS int)),0) + 1)::text, 5, '0')
      INTO v_new_entry
      FROM public.journal_entries WHERE organization_id = v_src.organization_id;

    INSERT INTO public.journal_entries (
      organization_id, business_id, branch_id, entry_number, entry_date,
      description, reference, source_type, source_subtype, source_id,
      journal_book_id, status, posted_at, posted_by, created_by,
      is_reversal, reversal_of_id
    ) VALUES (
      v_src.organization_id, v_src.business_id, v_src.branch_id, v_new_entry, CURRENT_DATE,
      'Reversal of physical count ' || v_src.count_number, v_src.count_number,
      'inventory_adjustment', 'physical_count_reversal', p_source_count_id,
      v_src.journal_book_id, 'posted', now(), p_user_id, p_user_id,
      true, v_orig_je
    ) RETURNING id INTO v_new_je;

    INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description, business_id, branch_id)
    SELECT v_new_je, jel.account_id, jel.credit, jel.debit,
           'Reversal: ' || COALESCE(jel.description,''), jel.business_id, jel.branch_id
      FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = v_orig_je;
  END IF;

  UPDATE public.physical_counts
     SET state = 'superseded', cancelled_at = now(),
         cancelled_by = p_user_id, cancellation_reason = p_reason
   WHERE id = p_source_count_id;

  INSERT INTO public.physical_count_events (count_id, organization_id, event_type, actor_id, payload)
  VALUES (p_source_count_id, v_src.organization_id, 'superseded', p_user_id,
          jsonb_build_object('reversal_adjustment_id', v_new_adj_id,
                             'reversal_journal_entry_id', v_new_je, 'reason', p_reason));

  RETURN jsonb_build_object('success', true,
    'reversal_adjustment_id', v_new_adj_id,
    'reversal_journal_entry_id', v_new_je);
END $$;