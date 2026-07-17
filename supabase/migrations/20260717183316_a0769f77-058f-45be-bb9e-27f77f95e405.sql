
-- =====================================================================
-- WMS Phase 1 — LPN + universal task substrate (ADR 0079)
-- Additive only. Mirrors stock_locations RLS shape and the
-- tg_stock_movement_emit_event outbox pattern (ADR 0076).
-- =====================================================================

-- ---------- Enums ----------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_lpn_type AS ENUM ('pallet', 'carton', 'tote', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_lpn_status AS ENUM ('open', 'sealed', 'shipped', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_task_type AS ENUM
    ('putaway', 'pick', 'pack', 'load', 'count', 'replenish', 'move', 'qc');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_task_state AS ENUM
    ('pending', 'assigned', 'in_progress', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Table: wms_license_plates --------------------------------
CREATE TABLE IF NOT EXISTS public.wms_license_plates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  business_id         uuid NOT NULL,
  branch_id           uuid,
  warehouse_id        uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  code                text NOT NULL,
  lpn_type            public.wms_lpn_type NOT NULL DEFAULT 'pallet',
  parent_lpn_id       uuid REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  current_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  status              public.wms_lpn_status NOT NULL DEFAULT 'open',
  sealed_at           timestamptz,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

CREATE INDEX IF NOT EXISTS wms_lpn_warehouse_idx    ON public.wms_license_plates (warehouse_id);
CREATE INDEX IF NOT EXISTS wms_lpn_business_idx     ON public.wms_license_plates (business_id);
CREATE INDEX IF NOT EXISTS wms_lpn_current_loc_idx  ON public.wms_license_plates (current_location_id);
CREATE INDEX IF NOT EXISTS wms_lpn_parent_idx       ON public.wms_license_plates (parent_lpn_id);
CREATE INDEX IF NOT EXISTS wms_lpn_status_idx       ON public.wms_license_plates (business_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_license_plates TO authenticated;
GRANT ALL ON public.wms_license_plates TO service_role;
ALTER TABLE public.wms_license_plates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_lpn_select" ON public.wms_license_plates FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "wms_lpn_insert" ON public.wms_license_plates FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE POLICY "wms_lpn_update" ON public.wms_license_plates FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "wms_lpn_delete" ON public.wms_license_plates FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'delete'));

CREATE OR REPLACE FUNCTION public._touch_wms_license_plates_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_lpn_touch ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_touch
  BEFORE UPDATE ON public.wms_license_plates
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_license_plates_updated_at();

-- ---------- Table: wms_tasks ----------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  business_id              uuid NOT NULL,
  branch_id                uuid,
  warehouse_id             uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  task_type                public.wms_task_type  NOT NULL,
  state                    public.wms_task_state NOT NULL DEFAULT 'pending',
  priority                 int  NOT NULL DEFAULT 100,
  sla_at                   timestamptz,
  assignee_user_id         uuid,
  source_doc_type          text,
  source_doc_id            uuid,
  source_location_id       uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  destination_location_id  uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  product_id               uuid REFERENCES public.products(id) ON DELETE SET NULL,
  lot_number               text,
  lpn_id                   uuid REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  quantity                 numeric,
  notes                    text,
  cancel_reason            text,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wms_tasks_queue_idx
  ON public.wms_tasks (business_id, state, priority DESC, sla_at NULLS LAST);
CREATE INDEX IF NOT EXISTS wms_tasks_assignee_idx    ON public.wms_tasks (assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wms_tasks_warehouse_idx   ON public.wms_tasks (warehouse_id);
CREATE INDEX IF NOT EXISTS wms_tasks_source_doc_idx  ON public.wms_tasks (source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS wms_tasks_lpn_idx         ON public.wms_tasks (lpn_id) WHERE lpn_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_tasks TO authenticated;
GRANT ALL ON public.wms_tasks TO service_role;
ALTER TABLE public.wms_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_tasks_select" ON public.wms_tasks FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "wms_tasks_insert" ON public.wms_tasks FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE POLICY "wms_tasks_update" ON public.wms_tasks FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "wms_tasks_delete" ON public.wms_tasks FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'delete'));

CREATE OR REPLACE FUNCTION public._touch_wms_tasks_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_tasks_touch ON public.wms_tasks;
CREATE TRIGGER trg_wms_tasks_touch
  BEFORE UPDATE ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_tasks_updated_at();

-- ---------- Trigger: emit task state events --------------------------
CREATE OR REPLACE FUNCTION public.tg_wms_task_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE NEW.state
    WHEN 'assigned'    THEN 'warehouse.task.assigned'
    WHEN 'in_progress' THEN 'warehouse.task.started'
    WHEN 'done'        THEN 'warehouse.task.completed'
    WHEN 'cancelled'   THEN 'warehouse.task.cancelled'
    ELSE NULL
  END;

  IF v_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
    v_event_type, 'wms_task', NEW.id,
    jsonb_build_object(
      'business_id', NEW.business_id,
      'task_type', NEW.task_type,
      'state', NEW.state,
      'priority', NEW.priority,
      'assignee_user_id', NEW.assignee_user_id,
      'source_doc_type', NEW.source_doc_type,
      'source_doc_id', NEW.source_doc_id,
      'source_location_id', NEW.source_location_id,
      'destination_location_id', NEW.destination_location_id,
      'product_id', NEW.product_id,
      'lot_number', NEW.lot_number,
      'lpn_id', NEW.lpn_id,
      'quantity', NEW.quantity,
      'started_at', NEW.started_at,
      'completed_at', NEW.completed_at
    ),
    'wms.task:' || NEW.id::text || ':' || NEW.state::text,
    NEW.assignee_user_id,
    'db_trigger'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_wms_task_emit_event failed for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_task_emit_event ON public.wms_tasks;
CREATE TRIGGER trg_wms_task_emit_event
  AFTER INSERT OR UPDATE OF state ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public.tg_wms_task_emit_event();

-- ---------- Trigger: emit LPN move / seal events ---------------------
CREATE OR REPLACE FUNCTION public.tg_wms_lpn_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_moved boolean := false;
  v_sealed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_moved := (NEW.current_location_id IS DISTINCT FROM OLD.current_location_id);
    v_sealed := (OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL);
  END IF;

  IF v_moved THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'warehouse.plate.moved', 'wms_license_plate', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'code', NEW.code,
        'from_location_id', OLD.current_location_id,
        'to_location_id', NEW.current_location_id,
        'lpn_type', NEW.lpn_type,
        'status', NEW.status
      ),
      'wms.plate.move:' || NEW.id::text || ':' || extract(epoch from now())::text,
      NULL, 'db_trigger'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF v_sealed THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'warehouse.plate.sealed', 'wms_license_plate', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'code', NEW.code,
        'sealed_at', NEW.sealed_at,
        'current_location_id', NEW.current_location_id
      ),
      'wms.plate.seal:' || NEW.id::text,
      NULL, 'db_trigger'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_wms_lpn_emit_event failed for lpn %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_lpn_emit_event ON public.wms_license_plates;
CREATE TRIGGER trg_wms_lpn_emit_event
  AFTER UPDATE ON public.wms_license_plates
  FOR EACH ROW EXECUTE FUNCTION public.tg_wms_lpn_emit_event();

-- ---------- RPC: move_lpn -------------------------------------------
CREATE OR REPLACE FUNCTION public.move_lpn(
  p_lpn_id uuid,
  p_dest_location_id uuid,
  p_note text DEFAULT NULL
)
RETURNS public.wms_license_plates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.wms_license_plates;
BEGIN
  UPDATE public.wms_license_plates
     SET current_location_id = p_dest_location_id,
         notes = COALESCE(p_note, notes),
         updated_at = now()
   WHERE id = p_lpn_id
     AND public.user_can_access_business(auth.uid(), business_id)
     AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write')
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'move_lpn: license plate % not found or not permitted', p_lpn_id
      USING ERRCODE = '42501';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.move_lpn(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.move_lpn(uuid, uuid, text) TO authenticated;

COMMENT ON TABLE public.wms_license_plates IS 'ADR 0079 — WMS License Plate Number (LPN). Pallet/carton/tote identity for handling units.';
COMMENT ON TABLE public.wms_tasks           IS 'ADR 0079 — WMS universal operator task queue (putaway/pick/pack/load/count/replenish/move/qc).';
