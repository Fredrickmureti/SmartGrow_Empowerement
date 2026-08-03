-- =====================================================================
-- Phase 3 — Task orchestration, scheduling, event-triggered counts.
-- =====================================================================

-- 1. Single implementation of session creation, actor-explicit ---------
CREATE OR REPLACE FUNCTION public.create_count_session_as(
  p_actor uuid,
  p_warehouse_id uuid,
  p_strategy text DEFAULT 'targeted',
  p_location_ids uuid[] DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_is_blind boolean DEFAULT false,
  p_assign_to uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wh record;
  v_session_id uuid;
  v_code text;
  v_pc_id uuid;
  v_products uuid[];
  v_seed jsonb;
  v_tasks int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;

  v_code := 'CC-' || to_char(clock_timestamp(), 'YYMMDD-HH24MISSMS');

  INSERT INTO public.wms_count_sessions (
    organization_id, business_id, branch_id, warehouse_id,
    code, strategy, state, notes, created_by, is_blind
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    v_code, p_strategy::public.wms_count_strategy, 'counting', p_notes, p_actor, p_is_blind
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.wms_count_lines (
    session_id, organization_id, business_id,
    location_id, product_id, lot_number, system_qty, assigned_to
  )
  SELECT
    v_session_id, v_wh.organization_id, v_wh.business_id,
    q.location_id, q.product_id, q.lot_number, COALESCE(q.quantity, 0), p_assign_to
    FROM public.stock_quants q
    JOIN public.stock_locations sl ON sl.id = q.location_id
   WHERE sl.warehouse_id = p_warehouse_id
     AND q.business_id = v_wh.business_id
     AND (p_location_ids IS NULL OR q.location_id = ANY(p_location_ids));

  -- Canonical count document (Inventory owns tolerance / approval / GL).
  SELECT array_agg(DISTINCT product_id),
         jsonb_agg(jsonb_build_object('product_id', product_id, 'system_qty', sys))
    INTO v_products, v_seed
    FROM (
      SELECT product_id, SUM(system_qty) AS sys
        FROM public.wms_count_lines
       WHERE session_id = v_session_id
       GROUP BY product_id
    ) agg;

  IF v_products IS NOT NULL THEN
    v_pc_id := public.physical_count_create(
      v_wh.organization_id, v_wh.business_id, p_warehouse_id, p_actor,
      'cycle',
      jsonb_build_object(
        'source', 'wms_count_session',
        'session_id', v_session_id,
        'session_code', v_code,
        'strategy', p_strategy,
        'blind', p_is_blind,
        'location_ids', to_jsonb(COALESCE(p_location_ids, ARRAY[]::uuid[]))
      ),
      NULL, NULL
    );

    PERFORM public.physical_count_freeze_scoped(v_pc_id, p_actor, v_products, v_seed);

    UPDATE public.wms_count_sessions
       SET physical_count_id = v_pc_id
     WHERE id = v_session_id;
  END IF;

  -- One claimable count task per bin.
  INSERT INTO public.wms_tasks (
    organization_id, business_id, branch_id, warehouse_id,
    task_type, state, priority, assignee_user_id,
    source_doc_type, source_doc_id, source_location_id, notes, created_by
  )
  SELECT DISTINCT
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id,
    'count'::public.wms_task_type,
    CASE WHEN p_assign_to IS NULL THEN 'pending'::public.wms_task_state
         ELSE 'assigned'::public.wms_task_state END,
    100, p_assign_to,
    'wms_count_session', v_session_id, l.location_id,
    'Cycle count ' || v_code, p_actor
    FROM public.wms_count_lines l
   WHERE l.session_id = v_session_id;
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  BEGIN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id, event_type,
      source_doc_type, source_doc_id, payload, idempotency_key, status, actor_user_id
    ) VALUES (
      v_wh.organization_id, v_wh.branch_id, p_warehouse_id,
      'warehouse.count.opened',
      'wms_count_session', v_session_id,
      jsonb_build_object(
        'session_id', v_session_id,
        'business_id', v_wh.business_id,
        'warehouse_id', p_warehouse_id,
        'strategy', p_strategy,
        'code', v_code,
        'blind', p_is_blind,
        'tasks_created', v_tasks,
        'physical_count_id', v_pc_id
      ),
      'wms.count.opened:' || v_session_id::text,
      'pending', p_actor
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'wms count opened outbox emit failed: %', SQLERRM;
  END;

  RETURN v_session_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.create_count_session_as(uuid, uuid, text, uuid[], text, boolean, uuid)
  TO authenticated, service_role;

-- Caller-facing wrapper keeps the access check at the edge.
CREATE OR REPLACE FUNCTION public.create_count_session(
  p_warehouse_id uuid,
  p_strategy text DEFAULT 'targeted',
  p_location_ids uuid[] DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_is_blind boolean DEFAULT false,
  p_assign_to uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_biz uuid;
BEGIN
  SELECT business_id INTO v_biz FROM public.warehouses WHERE id = p_warehouse_id;
  IF v_biz IS NULL THEN RAISE EXCEPTION 'warehouse % not found', p_warehouse_id; END IF;
  IF NOT user_can_access_business(auth.uid(), v_biz) THEN RAISE EXCEPTION 'access denied'; END IF;

  RETURN public.create_count_session_as(
    auth.uid(), p_warehouse_id, p_strategy, p_location_ids, p_notes, p_is_blind, p_assign_to
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.create_count_session(uuid, text, uuid[], text, boolean, uuid)
  TO authenticated, service_role;

-- 2. Schedules can drive scannable warehouse sessions ------------------
ALTER TABLE public.cycle_count_schedules
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'inventory'
    CHECK (execution_mode IN ('inventory','warehouse')),
  ADD COLUMN IF NOT EXISTS blind boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS location_ids uuid[] NULL,
  ADD COLUMN IF NOT EXISTS last_generated_session_id uuid NULL;

CREATE OR REPLACE FUNCTION public.generate_due_cycle_counts(p_now timestamptz DEFAULT now())
RETURNS TABLE(schedule_id uuid, count_id uuid, count_number text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_sched RECORD;
  v_count_id uuid;
  v_count_number text;
  v_session_id uuid;
BEGIN
  FOR v_sched IN
    SELECT * FROM public.cycle_count_schedules
     WHERE active AND next_run_at <= p_now
     ORDER BY next_run_at
     FOR UPDATE SKIP LOCKED
  LOOP
    IF v_sched.execution_mode = 'warehouse' THEN
      v_session_id := public.create_count_session_as(
        v_sched.created_by,
        v_sched.warehouse_id,
        CASE WHEN v_sched.scope_type = 'abc_class' THEN 'abc' ELSE 'targeted' END,
        v_sched.location_ids,
        'Auto-generated from cycle schedule: ' || v_sched.name,
        v_sched.blind,
        NULL
      );

      SELECT s.physical_count_id, pc.count_number
        INTO v_count_id, v_count_number
        FROM public.wms_count_sessions s
        LEFT JOIN public.physical_counts pc ON pc.id = s.physical_count_id
       WHERE s.id = v_session_id;

      UPDATE public.cycle_count_schedules
         SET last_run_at               = p_now,
             last_generated_count_id   = v_count_id,
             last_generated_session_id = v_session_id,
             next_run_at               = public.advance_cycle_count_next_run(v_sched.cadence, p_now)
       WHERE id = v_sched.id;
    ELSE
      v_count_number := 'CYC-' || to_char(p_now, 'YYYYMMDD') || '-' || substr(v_sched.id::text, 1, 8);

      INSERT INTO public.physical_counts (
        organization_id, business_id, branch_id, warehouse_id,
        count_number, count_date, count_type, state,
        tolerance_pct, tolerance_value, notes, created_by
      ) VALUES (
        v_sched.organization_id, v_sched.business_id, v_sched.branch_id, v_sched.warehouse_id,
        v_count_number, p_now::date, 'cycle', 'draft',
        v_sched.tolerance_pct, v_sched.tolerance_value,
        'Auto-generated from cycle schedule: ' || v_sched.name,
        v_sched.created_by
      ) RETURNING id INTO v_count_id;

      UPDATE public.cycle_count_schedules
         SET last_run_at             = p_now,
             last_generated_count_id = v_count_id,
             next_run_at             = public.advance_cycle_count_next_run(v_sched.cadence, p_now)
       WHERE id = v_sched.id;
    END IF;

    schedule_id  := v_sched.id;
    count_id     := v_count_id;
    count_number := v_count_number;
    RETURN NEXT;
  END LOOP;
END $$;

-- 3. Event-triggered counts --------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_count_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  trigger_event text NOT NULL
    CHECK (trigger_event IN ('variance','replenishment','return','receipt')),
  blind boolean NOT NULL DEFAULT true,
  cooldown_hours integer NOT NULL DEFAULT 24,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, trigger_event)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_count_triggers TO authenticated;
GRANT ALL ON public.wms_count_triggers TO service_role;
ALTER TABLE public.wms_count_triggers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wms_count_triggers read" ON public.wms_count_triggers;
CREATE POLICY "wms_count_triggers read" ON public.wms_count_triggers
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "wms_count_triggers write" ON public.wms_count_triggers;
CREATE POLICY "wms_count_triggers write" ON public.wms_count_triggers
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

DROP TRIGGER IF EXISTS trg_wms_count_triggers_updated_at ON public.wms_count_triggers;
CREATE TRIGGER trg_wms_count_triggers_updated_at
  BEFORE UPDATE ON public.wms_count_triggers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.wms_evaluate_count_trigger(
  p_warehouse_id uuid,
  p_location_id uuid,
  p_trigger_event text,
  p_actor uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rule record; v_recent int; v_session uuid;
BEGIN
  IF p_location_id IS NULL OR p_warehouse_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_rule FROM public.wms_count_triggers
   WHERE warehouse_id = p_warehouse_id
     AND trigger_event = p_trigger_event
     AND is_active = true;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Cooldown: don't re-queue a bin already counted or queued recently.
  SELECT count(*) INTO v_recent
    FROM public.wms_count_lines l
    JOIN public.wms_count_sessions s ON s.id = l.session_id
   WHERE l.location_id = p_location_id
     AND s.created_at > now() - make_interval(hours => v_rule.cooldown_hours);
  IF v_recent > 0 THEN RETURN NULL; END IF;

  v_session := public.create_count_session_as(
    COALESCE(p_actor, v_rule.created_by),
    p_warehouse_id, 'targeted', ARRAY[p_location_id],
    'Triggered by ' || p_trigger_event, v_rule.blind, NULL
  );

  RETURN v_session;
END $$;

GRANT EXECUTE ON FUNCTION public.wms_evaluate_count_trigger(uuid, uuid, text, uuid)
  TO authenticated, service_role;

-- Wire the four warehouse events to the rule evaluator.
CREATE OR REPLACE FUNCTION public._wms_count_trigger_from_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_event text; v_loc uuid;
BEGIN
  v_event := CASE NEW.event_type
    WHEN 'warehouse.count.posted'        THEN 'variance'
    WHEN 'warehouse.replenishment.completed' THEN 'replenishment'
    WHEN 'warehouse.return.dispositioned' THEN 'return'
    WHEN 'warehouse.receipt.staged'      THEN 'receipt'
    ELSE NULL END;
  IF v_event IS NULL OR NEW.warehouse_id IS NULL THEN RETURN NEW; END IF;

  v_loc := NULLIF(NEW.payload->>'location_id', '')::uuid;
  IF v_loc IS NULL THEN RETURN NEW; END IF;

  BEGIN
    PERFORM public.wms_evaluate_count_trigger(
      NEW.warehouse_id, v_loc, v_event, NEW.actor_user_id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'count trigger evaluation failed: %', SQLERRM;
  END;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_count_trigger_from_event ON public.business_event_outbox;
CREATE TRIGGER trg_wms_count_trigger_from_event
  AFTER INSERT ON public.business_event_outbox
  FOR EACH ROW EXECUTE FUNCTION public._wms_count_trigger_from_event();