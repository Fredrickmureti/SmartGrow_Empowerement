-- =====================================================================
-- WMS Operator Task Execution — foundations
-- 1. wms_task_events: append-only execution ledger
-- 2. Lease recovery for in-flight (not just claimed) tasks
-- 3. FSM as a hard invariant (column privileges)
-- 4. Single state vocabulary (legacy values rejected on write)
-- 5. Claim-path index correctness
-- =====================================================================

-- ---------- 1. Append-only task execution ledger ----------
CREATE TABLE public.wms_task_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid,
  business_id      uuid,
  branch_id        uuid,
  warehouse_id     uuid,
  task_id          uuid NOT NULL REFERENCES public.wms_tasks(id) ON DELETE CASCADE,
  task_type        public.wms_task_type,
  event_type       text NOT NULL,
  from_state       public.wms_task_state,
  to_state         public.wms_task_state,
  actor_id         uuid,
  actor_role       text,
  device_id        text,
  client_scan_id   uuid,
  source_location_id uuid,
  destination_location_id uuid,
  scanned_barcode  text,
  product_id       uuid,
  lot_number       text,
  serial_number    text,
  lpn_id           uuid,
  quantity         numeric,
  quantity_delta   numeric,
  source_doc_type  text,
  source_doc_id    uuid,
  correlation_id   uuid,
  reason           text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wms_task_events TO authenticated;
GRANT ALL ON public.wms_task_events TO service_role;

ALTER TABLE public.wms_task_events ENABLE ROW LEVEL SECURITY;

-- Read-only for app users, scoped exactly like the parent task.
-- No INSERT/UPDATE/DELETE policy: the ledger is written only by the
-- SECURITY DEFINER trigger below, and is immutable by construction.
CREATE POLICY "wms_task_events_select" ON public.wms_task_events
  FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

CREATE INDEX wms_task_events_task_idx ON public.wms_task_events (task_id, occurred_at DESC);
CREATE INDEX wms_task_events_actor_idx ON public.wms_task_events (actor_id, occurred_at DESC)
  WHERE actor_id IS NOT NULL;
CREATE INDEX wms_task_events_warehouse_idx ON public.wms_task_events (warehouse_id, occurred_at DESC);
CREATE INDEX wms_task_events_barcode_idx ON public.wms_task_events (scanned_barcode)
  WHERE scanned_barcode IS NOT NULL;
CREATE INDEX wms_task_events_source_doc_idx ON public.wms_task_events (source_doc_type, source_doc_id)
  WHERE source_doc_id IS NOT NULL;

-- Immutability guard: history is never rewritten.
CREATE OR REPLACE FUNCTION public._wms_task_events_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'wms_task_events is append-only (attempted %)', TG_OP
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER trg_wms_task_events_immutable
  BEFORE UPDATE OR DELETE ON public.wms_task_events
  FOR EACH ROW EXECUTE FUNCTION public._wms_task_events_immutable();

-- Ledger writer. Fires on task creation and on every state change, and
-- harvests the operator-context fields the RPCs merge into `payload`
-- (device_id, scanned barcode, serial, quantity captured, reason).
CREATE OR REPLACE FUNCTION public._wms_log_task_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_event_type text;
  v_from public.wms_task_state;
  v_payload jsonb := COALESCE(NEW.payload, '{}'::jsonb);
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_type := 'task.created';
    v_from := NULL;
  ELSE
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
      RETURN NEW;  -- only lifecycle transitions are ledger-worthy
    END IF;
    v_event_type := 'task.' || NEW.state::text;
    v_from := OLD.state;
  END IF;

  INSERT INTO public.wms_task_events (
    organization_id, business_id, branch_id, warehouse_id,
    task_id, task_type, event_type, from_state, to_state,
    actor_id, device_id, client_scan_id,
    source_location_id, destination_location_id,
    scanned_barcode, product_id, lot_number, serial_number,
    lpn_id, quantity, quantity_delta,
    source_doc_type, source_doc_id, correlation_id, reason, payload
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.warehouse_id,
    NEW.id, NEW.task_type, v_event_type, v_from, NEW.state,
    COALESCE(auth.uid(), NEW.claimed_by, NEW.assignee_user_id),
    COALESCE(v_payload->>'device_id', NEW.device_id),
    NULLIF(v_payload->>'client_scan_id','')::uuid,
    NEW.source_location_id, NEW.destination_location_id,
    COALESCE(v_payload->>'scanned_barcode', v_payload->>'barcode'),
    NEW.product_id, NEW.lot_number, v_payload->>'serial_number',
    NEW.lpn_id, NEW.quantity,
    NULLIF(v_payload->>'quantity_delta','')::numeric,
    NEW.source_doc_type, NEW.source_doc_id, NEW.correlation_id,
    COALESCE(NEW.cancel_reason, v_payload->>'reason'),
    v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never fail warehouse execution because auditing failed; surface loudly.
  RAISE WARNING 'wms_task_events write failed for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wms_tasks_log_event
  AFTER INSERT OR UPDATE OF state ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public._wms_log_task_event();

-- ---------- 2. Lease recovery for in-flight work ----------
-- Previously reaped only state='claimed'. A task that reached
-- in_progress / paused / resumed and then lost its heartbeat was
-- permanently stranded: wms_claim_next_task filters
-- (expires_at IS NULL OR expires_at > now()), so nobody could re-claim it.
CREATE OR REPLACE FUNCTION public.wms_task_reap_expired()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  WITH released AS (
    UPDATE public.wms_tasks
       SET state = 'available',
           claimed_by = NULL, claimed_at = NULL,
           heartbeat_at = NULL, expires_at = NULL,
           assignee_user_id = NULL,
           payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
             'reason', 'lease_expired',
             'reaped_from_state', state::text,
             'reaped_at', now()
           ),
           row_version = row_version + 1,
           updated_at = now()
     WHERE state IN ('claimed','in_progress','paused','resumed')
       AND expires_at IS NOT NULL
       AND expires_at < now()
     RETURNING id
  ) SELECT count(*) INTO n FROM released;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.wms_task_reap_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_task_reap_expired() TO service_role;
GRANT EXECUTE ON FUNCTION public.wms_task_reap_expired() TO authenticated;

-- ---------- 3. FSM as a hard invariant ----------
-- The transition RPCs are SECURITY DEFINER (owner-executed), so revoking
-- these columns from `authenticated` closes the direct-UPDATE bypass
-- without touching any legitimate writer.
REVOKE UPDATE (
  state, row_version, claimed_by, claimed_at, heartbeat_at,
  expires_at, assignee_user_id, priority, started_at, completed_at
) ON public.wms_tasks FROM authenticated;

-- ---------- 4. One state vocabulary ----------
-- wms_task_state accumulated two generations of values. The canonical set
-- is pending/available/claimed/in_progress/paused/resumed/completed/
-- exception/cancelled. Legacy 'assigned'/'done' are rejected on write.
-- (Enum values are not dropped: dependent function bodies still name them.)
CREATE OR REPLACE FUNCTION public._wms_tasks_canonical_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.state IN ('assigned','done') THEN
    RAISE EXCEPTION 'wms_task_state ''%'' is retired — use ''%'' instead',
      NEW.state::text,
      CASE NEW.state::text WHEN 'assigned' THEN 'claimed' ELSE 'completed' END
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wms_tasks_canonical_state
  BEFORE INSERT OR UPDATE OF state ON public.wms_tasks
  FOR EACH ROW EXECUTE FUNCTION public._wms_tasks_canonical_state();

-- ---------- 5. Claim-path index ----------
-- The claim predicate is state IN ('pending','available'); the old partial
-- index covered 'pending' alone and was therefore unusable on the hot path.
DROP INDEX IF EXISTS public.idx_wms_tasks_claim_lookup;
CREATE INDEX idx_wms_tasks_claim_lookup
  ON public.wms_tasks (warehouse_id, task_type, priority DESC, sla_at, created_at)
  WHERE state IN ('pending','available');

DROP INDEX IF EXISTS public.idx_wms_tasks_assignee;
CREATE INDEX idx_wms_tasks_assignee
  ON public.wms_tasks (assignee_user_id)
  WHERE state IN ('claimed','in_progress','paused','resumed');

DROP INDEX IF EXISTS public.idx_wms_tasks_heartbeat;
CREATE INDEX idx_wms_tasks_heartbeat
  ON public.wms_tasks (expires_at)
  WHERE state IN ('claimed','in_progress','paused','resumed');