-- =====================================================================
-- Phase 1b — Exceptions platform: lifecycle, evidence, links, policy.
-- Extends the existing canonical service; introduces no parallel queue.
-- =====================================================================

-- ------------------------------------------------ 1. header enrichment
ALTER TABLE public.wms_exceptions
  ADD COLUMN IF NOT EXISTS class            public.wms_exception_class NOT NULL DEFAULT 'operational',
  ADD COLUMN IF NOT EXISTS owner_role       public.wms_exception_owner_role,
  ADD COLUMN IF NOT EXISTS assigned_at      timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by      uuid,
  ADD COLUMN IF NOT EXISTS acknowledged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by  uuid,
  ADD COLUMN IF NOT EXISTS escalated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_level smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_breached_at  timestamptz,
  ADD COLUMN IF NOT EXISTS source_system    text NOT NULL DEFAULT 'wms',
  ADD COLUMN IF NOT EXISTS idempotency_key  text,
  ADD COLUMN IF NOT EXISTS financial_impact numeric(18,4),
  ADD COLUMN IF NOT EXISTS impact_currency  text;

CREATE UNIQUE INDEX IF NOT EXISTS wms_exceptions_idempotency_uq
  ON public.wms_exceptions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS wms_exceptions_triage_idx
  ON public.wms_exceptions (warehouse_id, state, severity DESC, due_by);
CREATE INDEX IF NOT EXISTS wms_exceptions_owner_idx
  ON public.wms_exceptions (assigned_to, state) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS wms_exceptions_role_idx
  ON public.wms_exceptions (owner_role, state) WHERE owner_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS wms_exceptions_aggregate_idx
  ON public.wms_exceptions (aggregate_type, aggregate_id);

-- ------------------------------------------- 2. append-only history log
CREATE TABLE IF NOT EXISTS public.wms_exception_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  exception_id    uuid NOT NULL REFERENCES public.wms_exceptions(id) ON DELETE CASCADE,
  event_type      public.wms_exception_event_type NOT NULL,
  from_state      public.wms_exception_state,
  to_state        public.wms_exception_state,
  actor_id        uuid,
  actor_role      public.wms_exception_owner_role,
  reason          text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wms_exception_events TO authenticated;
GRANT ALL    ON public.wms_exception_events TO service_role;
ALTER TABLE public.wms_exception_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_exception_events member read"
  ON public.wms_exception_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_events.business_id));
CREATE INDEX IF NOT EXISTS wms_exception_events_ex_idx
  ON public.wms_exception_events (exception_id, occurred_at);

-- ---------------------------------------------- 3. structured evidence
CREATE TABLE IF NOT EXISTS public.wms_exception_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  exception_id    uuid NOT NULL REFERENCES public.wms_exceptions(id) ON DELETE CASCADE,
  evidence_type   public.wms_exception_evidence_type NOT NULL,
  label           text,
  -- structured capture (weights, temperatures, readings)
  numeric_value   numeric(18,4),
  unit            text,
  text_value      text,
  -- binaries live in storage; we keep the path only
  storage_bucket  text,
  storage_path    text,
  external_url    text,
  device_id       uuid,
  captured_by     uuid,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_exception_evidence TO authenticated;
GRANT ALL ON public.wms_exception_evidence TO service_role;
ALTER TABLE public.wms_exception_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_exception_evidence member read"
  ON public.wms_exception_evidence FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_evidence.business_id));
CREATE POLICY "wms_exception_evidence member write"
  ON public.wms_exception_evidence FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_evidence.business_id));
CREATE POLICY "wms_exception_evidence member update"
  ON public.wms_exception_evidence FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_evidence.business_id));
CREATE INDEX IF NOT EXISTS wms_exception_evidence_ex_idx
  ON public.wms_exception_evidence (exception_id, captured_at DESC);

-- ------------------------------------------ 4. related business records
CREATE TABLE IF NOT EXISTS public.wms_exception_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  exception_id    uuid NOT NULL REFERENCES public.wms_exceptions(id) ON DELETE CASCADE,
  link_type       public.wms_exception_link_type NOT NULL,
  record_id       uuid,
  record_label    text,
  route_path      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exception_id, link_type, record_id)
);
GRANT SELECT, INSERT, DELETE ON public.wms_exception_links TO authenticated;
GRANT ALL ON public.wms_exception_links TO service_role;
ALTER TABLE public.wms_exception_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_exception_links member read"
  ON public.wms_exception_links FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_links.business_id));
CREATE POLICY "wms_exception_links member write"
  ON public.wms_exception_links FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_links.business_id));

-- -------------------------------------------- 5. declarative routing policy
CREATE TABLE IF NOT EXISTS public.wms_exception_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid,
  business_id           uuid,
  warehouse_id          uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  kind                  public.wms_exception_kind NOT NULL,
  class                 public.wms_exception_class NOT NULL DEFAULT 'operational',
  default_severity      smallint NOT NULL DEFAULT 2,
  sla_minutes           integer NOT NULL DEFAULT 240,
  owner_role            public.wms_exception_owner_role,
  escalation_after_mins integer,
  escalation_role       public.wms_exception_owner_role,
  max_escalation_level  smallint NOT NULL DEFAULT 2,
  requires_evidence     boolean NOT NULL DEFAULT false,
  required_evidence_types public.wms_exception_evidence_type[] NOT NULL DEFAULT '{}',
  notify_channels       text[] NOT NULL DEFAULT ARRAY['in_app'],
  auto_close_minutes    integer,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One global default per kind; optional per-business / per-warehouse overrides.
CREATE UNIQUE INDEX IF NOT EXISTS wms_exception_policies_global_uq
  ON public.wms_exception_policies (kind)
  WHERE business_id IS NULL AND warehouse_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wms_exception_policies_business_uq
  ON public.wms_exception_policies (business_id, kind)
  WHERE business_id IS NOT NULL AND warehouse_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wms_exception_policies_warehouse_uq
  ON public.wms_exception_policies (warehouse_id, kind)
  WHERE warehouse_id IS NOT NULL;

GRANT SELECT ON public.wms_exception_policies TO authenticated;
GRANT ALL ON public.wms_exception_policies TO service_role;
ALTER TABLE public.wms_exception_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wms_exception_policies read"
  ON public.wms_exception_policies FOR SELECT
  USING (
    business_id IS NULL
    OR EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_exception_policies.business_id)
  );

-- ------------------------------------------------------- 6. updated_at
CREATE TRIGGER wms_exception_evidence_touch
  BEFORE UPDATE ON public.wms_exception_evidence
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER wms_exception_policies_touch
  BEFORE UPDATE ON public.wms_exception_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- --------------------------------------------------- 7. realtime feeds
DO $$ BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_exception_events; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.wms_exception_evidence; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
