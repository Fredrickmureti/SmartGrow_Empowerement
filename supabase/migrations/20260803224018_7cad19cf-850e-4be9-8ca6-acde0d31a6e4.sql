-- ============================================================
-- Cross-dock Phase 1 — domain model
-- ============================================================

-- 1. Lifecycle enum -----------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_crossdock_state AS ENUM (
    'detected','qualified','rejected','approved','staging',
    'staged','loaded','completed','expired','broken','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_crossdock_demand_type AS ENUM (
    'sales_order','transfer','replenishment','production'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Rules table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_crossdock_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  -- qualification constraints
  min_shelf_life_days integer,
  allow_hazardous boolean NOT NULL DEFAULT false,
  allow_cold_chain boolean NOT NULL DEFAULT false,
  allow_lot_tracked boolean NOT NULL DEFAULT true,
  allow_serial_tracked boolean NOT NULL DEFAULT false,
  require_qc_pass boolean NOT NULL DEFAULT true,
  min_quantity numeric NOT NULL DEFAULT 0,
  max_quantity numeric,
  max_hours_to_cutoff numeric NOT NULL DEFAULT 48,
  min_hours_to_cutoff numeric NOT NULL DEFAULT 0.5,
  require_full_line boolean NOT NULL DEFAULT false,
  auto_approve_score numeric,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_crossdock_rules TO authenticated;
GRANT ALL ON public.wms_crossdock_rules TO service_role;
ALTER TABLE public.wms_crossdock_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_crossdock_rules_select ON public.wms_crossdock_rules;
CREATE POLICY wms_crossdock_rules_select ON public.wms_crossdock_rules
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS wms_crossdock_rules_write ON public.wms_crossdock_rules;
CREATE POLICY wms_crossdock_rules_write ON public.wms_crossdock_rules
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'manager')))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
         AND (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'manager')));

CREATE INDEX IF NOT EXISTS idx_wms_crossdock_rules_scope
  ON public.wms_crossdock_rules (business_id, warehouse_id, is_active, priority);

DROP TRIGGER IF EXISTS trg_wms_crossdock_rules_updated_at ON public.wms_crossdock_rules;
CREATE TRIGGER trg_wms_crossdock_rules_updated_at
  BEFORE UPDATE ON public.wms_crossdock_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Opportunity lifecycle columns -------------------------------------
ALTER TABLE public.wms_crossdock_opportunities
  ADD COLUMN IF NOT EXISTS state public.wms_crossdock_state,
  ADD COLUMN IF NOT EXISTS demand_type public.wms_crossdock_demand_type NOT NULL DEFAULT 'sales_order',
  ADD COLUMN IF NOT EXISTS demand_doc_id uuid,
  ADD COLUMN IF NOT EXISTS demand_line_id uuid,
  ADD COLUMN IF NOT EXISTS score numeric,
  ADD COLUMN IF NOT EXISTS rule_id uuid REFERENCES public.wms_crossdock_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reject_reason text,
  ADD COLUMN IF NOT EXISTS break_reason text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS staging_location_id uuid REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outbound_dock_id uuid REFERENCES public.warehouse_docks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES public.wms_dock_appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid,
  ADD COLUMN IF NOT EXISTS load_task_id uuid,
  ADD COLUMN IF NOT EXISTS manifest_id uuid,
  ADD COLUMN IF NOT EXISTS savings_estimate numeric,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

-- backfill lifecycle from legacy status
UPDATE public.wms_crossdock_opportunities
   SET state = CASE status
                 WHEN 'open' THEN 'qualified'::public.wms_crossdock_state
                 WHEN 'staged' THEN 'staged'::public.wms_crossdock_state
                 WHEN 'cancelled' THEN 'cancelled'::public.wms_crossdock_state
                 ELSE 'detected'::public.wms_crossdock_state
               END
 WHERE state IS NULL;

UPDATE public.wms_crossdock_opportunities
   SET demand_doc_id = COALESCE(demand_doc_id, sales_order_id),
       demand_line_id = COALESCE(demand_line_id, sales_order_item_id)
 WHERE demand_doc_id IS NULL;

ALTER TABLE public.wms_crossdock_opportunities
  ALTER COLUMN state SET DEFAULT 'detected'::public.wms_crossdock_state;
ALTER TABLE public.wms_crossdock_opportunities
  ALTER COLUMN state SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wms_crossdock_state
  ON public.wms_crossdock_opportunities (business_id, warehouse_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_wms_crossdock_demand
  ON public.wms_crossdock_opportunities (demand_type, demand_doc_id, demand_line_id);

-- 4. Legacy status mirror + row_version bump ---------------------------
CREATE OR REPLACE FUNCTION public._wms_crossdock_sync_legacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.status := CASE
    WHEN NEW.state IN ('detected','qualified','approved','staging') THEN 'open'
    WHEN NEW.state IN ('staged','loaded','completed') THEN 'staged'
    ELSE 'cancelled'
  END;
  IF TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.row_version := COALESCE(OLD.row_version, 1) + 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_sync_legacy ON public.wms_crossdock_opportunities;
CREATE TRIGGER trg_wms_crossdock_sync_legacy
  BEFORE INSERT OR UPDATE ON public.wms_crossdock_opportunities
  FOR EACH ROW EXECUTE FUNCTION public._wms_crossdock_sync_legacy();

-- 5. History table ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_crossdock_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  opportunity_id uuid NOT NULL REFERENCES public.wms_crossdock_opportunities(id) ON DELETE CASCADE,
  from_state public.wms_crossdock_state,
  to_state public.wms_crossdock_state NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wms_crossdock_history TO authenticated;
GRANT ALL ON public.wms_crossdock_history TO service_role;
ALTER TABLE public.wms_crossdock_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wms_crossdock_history_select ON public.wms_crossdock_history;
CREATE POLICY wms_crossdock_history_select ON public.wms_crossdock_history
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE INDEX IF NOT EXISTS idx_wms_crossdock_history_opp
  ON public.wms_crossdock_history (opportunity_id, created_at DESC);

-- history is append-only
CREATE OR REPLACE FUNCTION public._wms_crossdock_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'wms_crossdock_history is append-only';
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_history_immutable ON public.wms_crossdock_history;
CREATE TRIGGER trg_wms_crossdock_history_immutable
  BEFORE UPDATE OR DELETE ON public.wms_crossdock_history
  FOR EACH ROW EXECUTE FUNCTION public._wms_crossdock_history_immutable();

-- auto-record every lifecycle change
CREATE OR REPLACE FUNCTION public._wms_crossdock_record_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO public.wms_crossdock_history (
      organization_id, business_id, opportunity_id,
      from_state, to_state, reason, actor_id, details
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.id,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
      NEW.state,
      COALESCE(NEW.reject_reason, NEW.break_reason, NEW.cancel_reason),
      auth.uid(),
      jsonb_build_object('score', NEW.score, 'expires_at', NEW.expires_at)
    );
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_record_history ON public.wms_crossdock_opportunities;
CREATE TRIGGER trg_wms_crossdock_record_history
  AFTER INSERT OR UPDATE ON public.wms_crossdock_opportunities
  FOR EACH ROW EXECUTE FUNCTION public._wms_crossdock_record_history();

-- 6. Richer event emitter ----------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_crossdock_event(p_type text, p_row public.wms_crossdock_opportunities)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id, branch_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      p_type, p_row.organization_id, p_row.business_id, p_row.branch_id,
      'crossdock_opportunity', p_row.id,
      jsonb_build_object(
        'opportunity_id', p_row.id,
        'warehouse_id', p_row.warehouse_id,
        'grn_id', p_row.grn_id,
        'grn_line_id', p_row.grn_line_id,
        'receiving_line_id', p_row.receiving_line_id,
        'product_id', p_row.product_id,
        'quantity', p_row.quantity,
        'demand_type', p_row.demand_type,
        'demand_doc_id', p_row.demand_doc_id,
        'demand_line_id', p_row.demand_line_id,
        'sales_order_id', p_row.sales_order_id,
        'sales_order_item_id', p_row.sales_order_item_id,
        'state', p_row.state,
        'status', p_row.status,
        'score', p_row.score,
        'expires_at', p_row.expires_at,
        'staging_location_id', p_row.staging_location_id,
        'outbound_dock_id', p_row.outbound_dock_id,
        'stage_task_id', p_row.stage_task_id,
        'load_task_id', p_row.load_task_id,
        'row_version', p_row.row_version
      ),
      'wms.crossdock:' || p_row.id || ':' || p_row.state || ':' || p_row.row_version,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crossdock event emission failed: %', SQLERRM;
  END;
END $$;