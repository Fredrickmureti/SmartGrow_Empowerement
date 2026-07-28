
-- =========================================================
-- Phase 1.1 — WMS domain foundation
-- =========================================================

-- ---------- 1. New enums (guarded) ----------
DO $$ BEGIN
  CREATE TYPE public.wms_appointment_state AS ENUM
    ('requested','confirmed','arrived','docked','unloading','unloaded','closed','no_show','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_qc_state AS ENUM
    ('pending','in_progress','passed','failed','conditional','closed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_pack_state AS ENUM
    ('open','sealed','labeled','staged','voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_return_state AS ENUM
    ('draft','authorized','in_transit','received','inspecting','disposed','closed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_return_disposition AS ENUM
    ('restock','scrap','repair','return_to_vendor','hold');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_receiving_state AS ENUM
    ('open','unloading','captured','discrepant','posted','closed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_exception_kind AS ENUM
    ('receiving_discrepancy','qc_fail','short_pick','count_variance','damaged_lpn',
     'unknown_scan','invalid_bin','capacity_exceeded','stale_task','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_exception_state AS ENUM
    ('open','acknowledged','investigating','resolved','wont_fix','escalated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 2. Extend existing enums (safe, additive) ----------
-- Widen LPN lifecycle. Old values (open/sealed/shipped/retired) remain valid.
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'draft'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'receiving'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'putaway'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'stored'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'picked'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'packed'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'staged'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'loaded'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'quarantined'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'consumed'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_lpn_status ADD VALUE IF NOT EXISTS 'voided'; EXCEPTION WHEN others THEN NULL; END $$;

-- Task lifecycle: add explicit 'available'/'claimed'/'completed'/'exception' aliases
DO $$ BEGIN ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'available'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'claimed'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'completed'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.wms_task_state ADD VALUE IF NOT EXISTS 'exception'; EXCEPTION WHEN others THEN NULL; END $$;

-- ---------- 3. Extend existing tables ----------
ALTER TABLE public.wms_tasks
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_by UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS device_id UUID;

CREATE INDEX IF NOT EXISTS idx_wms_tasks_claim_lookup
  ON public.wms_tasks (warehouse_id, task_type, state, priority DESC, created_at ASC)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_wms_tasks_assignee
  ON public.wms_tasks (assignee_user_id) WHERE state IN ('assigned','in_progress');

CREATE INDEX IF NOT EXISTS idx_wms_tasks_heartbeat
  ON public.wms_tasks (heartbeat_at) WHERE state = 'in_progress';

ALTER TABLE public.wms_license_plates
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

-- ---------- 4. Helper: emit warehouse event onto outbox ----------
CREATE OR REPLACE FUNCTION public._wms_emit_event(
  _event_type TEXT,
  _aggregate_id UUID,
  _org_id UUID,
  _business_id UUID,
  _warehouse_id UUID,
  _branch_id UUID,
  _actor UUID,
  _payload JSONB,
  _idempotency_key TEXT DEFAULT NULL,
  _source_doc_type TEXT DEFAULT NULL,
  _source_doc_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
  _key TEXT := COALESCE(_idempotency_key, _event_type || ':' || _aggregate_id::text);
BEGIN
  INSERT INTO public.business_event_outbox
    (event_type, idempotency_key, payload, org_id, warehouse_id, branch_id,
     actor_user_id, source, source_doc_type, source_doc_id, status)
  VALUES
    (_event_type, _key,
     COALESCE(_payload,'{}'::jsonb) || jsonb_build_object(
       'aggregate_id', _aggregate_id,
       'business_id',  _business_id,
       'warehouse_id', _warehouse_id,
       'branch_id',    _branch_id,
       'actor_id',     _actor,
       'occurred_at',  now()
     ),
     _org_id, _warehouse_id, _branch_id, _actor, 'wms',
     _source_doc_type, _source_doc_id, 'pending')
  ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END $$;

-- ---------- 5. FSM guards ----------
-- Task transition. Enforces edges and stamps timestamps + row_version.
CREATE OR REPLACE FUNCTION public.wms_transition_task(
  _task_id UUID,
  _to_state public.wms_task_state,
  _expected_version INTEGER,
  _actor UUID DEFAULT auth.uid(),
  _reason TEXT DEFAULT NULL,
  _payload_patch JSONB DEFAULT '{}'::jsonb
) RETURNS public.wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.wms_tasks;
  ok BOOLEAN;
BEGIN
  SELECT * INTO t FROM public.wms_tasks WHERE id = _task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_task_not_found: %', _task_id USING ERRCODE = 'P0002'; END IF;
  IF t.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_task_stale: expected v% got v%', _expected_version, t.row_version USING ERRCODE = '40001';
  END IF;

  ok := CASE t.state::text || '>' || _to_state::text
    WHEN 'pending>available'      THEN TRUE
    WHEN 'pending>claimed'        THEN TRUE
    WHEN 'available>claimed'      THEN TRUE
    WHEN 'available>cancelled'    THEN TRUE
    WHEN 'assigned>claimed'       THEN TRUE
    WHEN 'assigned>in_progress'   THEN TRUE
    WHEN 'claimed>in_progress'    THEN TRUE
    WHEN 'claimed>available'      THEN TRUE
    WHEN 'claimed>exception'      THEN TRUE
    WHEN 'in_progress>completed'  THEN TRUE
    WHEN 'in_progress>done'       THEN TRUE
    WHEN 'in_progress>exception'  THEN TRUE
    WHEN 'in_progress>available'  THEN TRUE
    WHEN 'exception>available'    THEN TRUE
    WHEN 'exception>cancelled'    THEN TRUE
    WHEN 'pending>cancelled'      THEN TRUE
    WHEN 'available>pending'      THEN TRUE
    ELSE FALSE
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'wms_task_bad_edge: % -> %', t.state, _to_state USING ERRCODE = '22023';
  END IF;

  UPDATE public.wms_tasks SET
    state = _to_state,
    row_version = t.row_version + 1,
    started_at   = CASE WHEN _to_state IN ('in_progress','claimed') AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at = CASE WHEN _to_state IN ('completed','done') THEN now() ELSE completed_at END,
    cancel_reason = CASE WHEN _to_state = 'cancelled' THEN COALESCE(_reason, cancel_reason) ELSE cancel_reason END,
    payload = payload || COALESCE(_payload_patch,'{}'::jsonb),
    updated_at = now()
  WHERE id = _task_id
  RETURNING * INTO t;

  PERFORM public._wms_emit_event(
    'warehouse.task.' || _to_state::text,
    t.id, t.organization_id, t.business_id, t.warehouse_id, t.branch_id, _actor,
    jsonb_build_object('task_type', t.task_type, 'from_state', t.state, 'reason', _reason),
    'wms.task:' || t.id::text || ':' || _to_state::text,
    t.source_doc_type, t.source_doc_id
  );
  RETURN t;
END $$;

-- License plate transition.
CREATE OR REPLACE FUNCTION public.wms_transition_lpn(
  _lpn_id UUID,
  _to_status public.wms_lpn_status,
  _expected_version INTEGER,
  _to_location UUID DEFAULT NULL,
  _actor UUID DEFAULT auth.uid(),
  _reason TEXT DEFAULT NULL
) RETURNS public.wms_license_plates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.wms_license_plates;
  ok BOOLEAN;
BEGIN
  SELECT * INTO l FROM public.wms_license_plates WHERE id = _lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wms_lpn_not_found: %', _lpn_id USING ERRCODE = 'P0002'; END IF;
  IF l.row_version <> _expected_version THEN
    RAISE EXCEPTION 'wms_lpn_stale' USING ERRCODE = '40001';
  END IF;

  ok := CASE l.status::text || '>' || _to_status::text
    WHEN 'draft>receiving'      THEN TRUE
    WHEN 'open>receiving'       THEN TRUE
    WHEN 'receiving>putaway'    THEN TRUE
    WHEN 'putaway>stored'       THEN TRUE
    WHEN 'stored>picked'        THEN TRUE
    WHEN 'picked>packed'        THEN TRUE
    WHEN 'packed>sealed'        THEN TRUE
    WHEN 'packed>staged'        THEN TRUE
    WHEN 'sealed>staged'        THEN TRUE
    WHEN 'staged>loaded'        THEN TRUE
    WHEN 'loaded>shipped'       THEN TRUE
    WHEN 'stored>quarantined'   THEN TRUE
    WHEN 'receiving>quarantined' THEN TRUE
    WHEN 'quarantined>stored'   THEN TRUE
    WHEN 'quarantined>voided'   THEN TRUE
    WHEN 'stored>consumed'      THEN TRUE
    WHEN 'draft>voided'         THEN TRUE
    WHEN 'stored>voided'        THEN TRUE
    WHEN 'shipped>retired'      THEN TRUE
    WHEN 'shipped>voided'       THEN TRUE
    ELSE FALSE
  END;
  IF NOT ok THEN RAISE EXCEPTION 'wms_lpn_bad_edge: % -> %', l.status, _to_status USING ERRCODE = '22023'; END IF;

  UPDATE public.wms_license_plates SET
    status = _to_status,
    current_location_id = COALESCE(_to_location, current_location_id),
    row_version = l.row_version + 1,
    updated_at = now()
  WHERE id = _lpn_id
  RETURNING * INTO l;

  PERFORM public._wms_emit_event(
    'warehouse.lpn.' || _to_status::text,
    l.id, l.organization_id, l.business_id, l.warehouse_id, l.branch_id, _actor,
    jsonb_build_object('code', l.code, 'from_status', l.status, 'to_location', _to_location, 'reason', _reason),
    'wms.lpn:' || l.id::text || ':' || _to_status::text
  );
  RETURN l;
END $$;

-- ---------- 6. Claim next task (concurrency-safe) ----------
CREATE OR REPLACE FUNCTION public.wms_claim_next_task(
  _warehouse_id UUID,
  _task_types public.wms_task_type[] DEFAULT NULL,
  _zone_id UUID DEFAULT NULL,
  _lease_seconds INTEGER DEFAULT 300
) RETURNS public.wms_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.wms_tasks;
BEGIN
  SELECT * INTO t
  FROM public.wms_tasks
  WHERE warehouse_id = _warehouse_id
    AND state IN ('pending','available')
    AND (_task_types IS NULL OR task_type = ANY(_task_types))
    AND (_zone_id IS NULL OR zone_id = _zone_id OR zone_id IS NULL)
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY priority DESC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.wms_tasks SET
    state = 'claimed',
    claimed_by = auth.uid(),
    claimed_at = now(),
    heartbeat_at = now(),
    expires_at = now() + make_interval(secs => _lease_seconds),
    assignee_user_id = auth.uid(),
    row_version = t.row_version + 1,
    updated_at = now()
  WHERE id = t.id
  RETURNING * INTO t;

  PERFORM public._wms_emit_event(
    'warehouse.task.claimed', t.id, t.organization_id, t.business_id, t.warehouse_id, t.branch_id, auth.uid(),
    jsonb_build_object('task_type', t.task_type),
    'wms.task:' || t.id::text || ':claimed', t.source_doc_type, t.source_doc_id);
  RETURN t;
END $$;

-- Heartbeat: keeps a claim alive; releases if lease has expired.
CREATE OR REPLACE FUNCTION public.wms_task_heartbeat(
  _task_id UUID, _lease_seconds INTEGER DEFAULT 300
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE ok BOOLEAN;
BEGIN
  UPDATE public.wms_tasks
     SET heartbeat_at = now(),
         expires_at   = now() + make_interval(secs => _lease_seconds),
         updated_at   = now()
   WHERE id = _task_id
     AND claimed_by = auth.uid()
     AND state IN ('claimed','in_progress')
  RETURNING TRUE INTO ok;
  RETURN COALESCE(ok, FALSE);
END $$;

-- Reap: releases claims whose lease expired without a heartbeat.
CREATE OR REPLACE FUNCTION public.wms_task_reap_expired() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  WITH released AS (
    UPDATE public.wms_tasks
       SET state = 'available', claimed_by = NULL, claimed_at = NULL,
           heartbeat_at = NULL, expires_at = NULL,
           assignee_user_id = NULL,
           row_version = row_version + 1, updated_at = now()
     WHERE state = 'claimed' AND expires_at IS NOT NULL AND expires_at < now()
     RETURNING id
  ) SELECT count(*) INTO n FROM released;
  RETURN n;
END $$;

-- ---------- 7. New tables ----------

-- Event catalog (published metadata for every warehouse.* topic)
CREATE TABLE IF NOT EXISTS public.wms_events_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL UNIQUE,
  aggregate TEXT NOT NULL,
  transition TEXT NOT NULL,
  producers TEXT[] NOT NULL DEFAULT '{}',
  consumers TEXT[] NOT NULL DEFAULT '{}',
  payload_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  idempotency_key_shape TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wms_events_catalog TO authenticated;
GRANT ALL    ON public.wms_events_catalog TO service_role;
ALTER TABLE public.wms_events_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_events_catalog read" ON public.wms_events_catalog FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "wms_events_catalog admin write" ON public.wms_events_catalog FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Exceptions (single triage inbox)
CREATE TABLE IF NOT EXISTS public.wms_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  kind public.wms_exception_kind NOT NULL,
  state public.wms_exception_state NOT NULL DEFAULT 'open',
  severity SMALLINT NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  aggregate_type TEXT,
  aggregate_id UUID,
  task_id UUID REFERENCES public.wms_tasks(id) ON DELETE SET NULL,
  lpn_id UUID REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  raised_by UUID,
  assigned_to UUID,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.wms_exceptions TO authenticated;
GRANT ALL ON public.wms_exceptions TO service_role;
ALTER TABLE public.wms_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_exceptions member read" ON public.wms_exceptions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exceptions.business_id));
CREATE POLICY "wms_exceptions member write" ON public.wms_exceptions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exceptions.business_id));
CREATE POLICY "wms_exceptions member update" ON public.wms_exceptions FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exceptions.business_id));
CREATE INDEX IF NOT EXISTS idx_wms_exceptions_open ON public.wms_exceptions (warehouse_id, state, severity DESC, created_at DESC) WHERE state IN ('open','acknowledged','investigating');

-- Receiving sessions & lines (unload / GRN capture)
CREATE TABLE IF NOT EXISTS public.wms_receiving_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  appointment_id UUID,
  source_doc_type TEXT,
  source_doc_id UUID,
  dock_id UUID REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  state public.wms_receiving_state NOT NULL DEFAULT 'open',
  started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  supervisor_id UUID,
  notes TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, warehouse_id, code)
);
GRANT SELECT, INSERT, UPDATE ON public.wms_receiving_sessions TO authenticated;
GRANT ALL ON public.wms_receiving_sessions TO service_role;
ALTER TABLE public.wms_receiving_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_recv_sessions read" ON public.wms_receiving_sessions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_receiving_sessions.business_id));
CREATE POLICY "wms_recv_sessions write" ON public.wms_receiving_sessions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_receiving_sessions.business_id));
CREATE POLICY "wms_recv_sessions update" ON public.wms_receiving_sessions FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_receiving_sessions.business_id));

CREATE TABLE IF NOT EXISTS public.wms_receiving_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.wms_receiving_sessions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  product_id UUID NOT NULL,
  lpn_id UUID REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  lot_number TEXT,
  serial_number TEXT,
  expected_qty NUMERIC,
  received_qty NUMERIC NOT NULL DEFAULT 0,
  uom TEXT,
  staging_location_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  captured_by UUID,
  captured_at TIMESTAMPTZ,
  discrepancy_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_receiving_lines TO authenticated;
GRANT ALL ON public.wms_receiving_lines TO service_role;
ALTER TABLE public.wms_receiving_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_recv_lines rw" ON public.wms_receiving_lines FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wms_receiving_sessions s WHERE s.id = wms_receiving_lines.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.wms_receiving_sessions s WHERE s.id = wms_receiving_lines.session_id));
CREATE INDEX IF NOT EXISTS idx_wms_recv_lines_session ON public.wms_receiving_lines (session_id);

-- Return orders & lines
CREATE TABLE IF NOT EXISTS public.wms_return_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  branch_id UUID,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  rma_reference TEXT,
  source_doc_type TEXT,
  source_doc_id UUID,
  customer_id UUID,
  vendor_id UUID,
  state public.wms_return_state NOT NULL DEFAULT 'draft',
  expected_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  row_version INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, warehouse_id, code)
);
GRANT SELECT, INSERT, UPDATE ON public.wms_return_orders TO authenticated;
GRANT ALL ON public.wms_return_orders TO service_role;
ALTER TABLE public.wms_return_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_return_orders read" ON public.wms_return_orders FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_return_orders.business_id));
CREATE POLICY "wms_return_orders write" ON public.wms_return_orders FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_return_orders.business_id));
CREATE POLICY "wms_return_orders update" ON public.wms_return_orders FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_return_orders.business_id));

CREATE TABLE IF NOT EXISTS public.wms_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_order_id UUID NOT NULL REFERENCES public.wms_return_orders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  product_id UUID NOT NULL,
  lpn_id UUID REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  lot_number TEXT,
  serial_number TEXT,
  expected_qty NUMERIC NOT NULL DEFAULT 0,
  received_qty NUMERIC NOT NULL DEFAULT 0,
  disposition public.wms_return_disposition,
  qc_inspection_id UUID,
  destination_location_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_return_lines TO authenticated;
GRANT ALL ON public.wms_return_lines TO service_role;
ALTER TABLE public.wms_return_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_return_lines rw" ON public.wms_return_lines FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wms_return_orders o WHERE o.id = wms_return_lines.return_order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.wms_return_orders o WHERE o.id = wms_return_lines.return_order_id));

-- Replenishment rules
CREATE TABLE IF NOT EXISTS public.wms_replen_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  pick_face_location_id UUID NOT NULL REFERENCES public.stock_locations(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  min_qty NUMERIC NOT NULL,
  max_qty NUMERIC NOT NULL,
  target_qty NUMERIC NOT NULL,
  uom TEXT,
  source_zone_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_qty >= 0 AND target_qty >= min_qty AND max_qty >= target_qty),
  UNIQUE (business_id, warehouse_id, pick_face_location_id, product_id)
);
GRANT SELECT ON public.wms_replen_rules TO authenticated;
GRANT ALL ON public.wms_replen_rules TO service_role;
ALTER TABLE public.wms_replen_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_replen_rules read" ON public.wms_replen_rules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_replen_rules.business_id));
CREATE POLICY "wms_replen_rules admin write" ON public.wms_replen_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- Slotting rules
CREATE TABLE IF NOT EXISTS public.wms_slotting_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  velocity_class TEXT,
  product_family TEXT,
  requires_temp_control BOOLEAN NOT NULL DEFAULT FALSE,
  is_hazmat BOOLEAN NOT NULL DEFAULT FALSE,
  max_weight_kg NUMERIC,
  target_zone_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wms_slotting_rules TO authenticated;
GRANT ALL ON public.wms_slotting_rules TO service_role;
ALTER TABLE public.wms_slotting_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_slotting_rules read" ON public.wms_slotting_rules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_slotting_rules.business_id));
CREATE POLICY "wms_slotting_rules admin write" ON public.wms_slotting_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ---------- 8. updated_at triggers on new tables ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='_set_updated_at') THEN
    CREATE OR REPLACE FUNCTION public._set_updated_at() RETURNS TRIGGER
    LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_exceptions_touch BEFORE UPDATE ON public.wms_exceptions
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_recv_sessions_touch BEFORE UPDATE ON public.wms_receiving_sessions
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_recv_lines_touch BEFORE UPDATE ON public.wms_receiving_lines
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_return_orders_touch BEFORE UPDATE ON public.wms_return_orders
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_return_lines_touch BEFORE UPDATE ON public.wms_return_lines
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_replen_rules_touch BEFORE UPDATE ON public.wms_replen_rules
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_slotting_rules_touch BEFORE UPDATE ON public.wms_slotting_rules
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_wms_events_catalog_touch BEFORE UPDATE ON public.wms_events_catalog
    FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 9. Realtime publication ----------
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_exceptions;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_receiving_sessions;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_return_orders;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN others THEN NULL; END $$;
