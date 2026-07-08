
-- ============================================================
-- D1 — Physical Count aggregate + state machine
-- ============================================================

-- 1. physical_counts (header)
CREATE TABLE public.physical_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
  count_number text NOT NULL,
  count_type text NOT NULL DEFAULT 'full' CHECK (count_type IN ('full','cycle','spot','abc')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','counting','counted','in_review','approved','posted','cancelled','superseded')),
  tolerance_pct numeric,
  tolerance_value numeric,
  journal_book_id uuid,
  source_count_id uuid REFERENCES public.physical_counts(id),
  superseded_by uuid REFERENCES public.physical_counts(id),
  posted_adjustment_ids uuid[] DEFAULT '{}',
  posted_journal_entry_id uuid,
  frozen_at timestamptz,
  frozen_by uuid,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  posted_at timestamptz,
  posted_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  notes text,
  attachments jsonb DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, count_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.physical_counts TO authenticated;
GRANT ALL ON public.physical_counts TO service_role;
ALTER TABLE public.physical_counts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read physical_counts"
  ON public.physical_counts FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "org members write physical_counts"
  ON public.physical_counts FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "org members update physical_counts"
  ON public.physical_counts FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "service_role all physical_counts"
  ON public.physical_counts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_physical_counts_org_state ON public.physical_counts(organization_id, state);
CREATE INDEX idx_physical_counts_warehouse ON public.physical_counts(warehouse_id, state);

-- 2. physical_count_lines
CREATE TABLE public.physical_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL REFERENCES public.physical_counts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  packaging_id uuid,
  lot_id uuid,
  bin_id uuid,
  system_qty_at_freeze numeric NOT NULL DEFAULT 0,
  freeze_reconciliation_qty numeric NOT NULL DEFAULT 0,
  counted_qty numeric,
  recount_qty numeric,
  variance_qty numeric GENERATED ALWAYS AS
    (COALESCE(recount_qty, counted_qty, 0) - (system_qty_at_freeze + freeze_reconciliation_qty)) STORED,
  unit_cost_snapshot numeric,
  variance_value numeric,
  cost_source text CHECK (cost_source IN ('fifo','wac','last','standard') OR cost_source IS NULL),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','counted','matched','variance','recount_required','approved','rejected')),
  counted_by uuid,
  counted_at timestamptz,
  device_id uuid,
  scan_events jsonb DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id, product_id, packaging_id, lot_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.physical_count_lines TO authenticated;
GRANT ALL ON public.physical_count_lines TO service_role;
ALTER TABLE public.physical_count_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read physical_count_lines"
  ON public.physical_count_lines FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "org members write physical_count_lines"
  ON public.physical_count_lines FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "service_role all physical_count_lines"
  ON public.physical_count_lines FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_pc_lines_count ON public.physical_count_lines(count_id);
CREATE INDEX idx_pc_lines_product ON public.physical_count_lines(product_id);

-- 3. physical_count_events (append-only audit)
CREATE TABLE public.physical_count_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL REFERENCES public.physical_counts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.physical_count_events TO authenticated;
GRANT ALL ON public.physical_count_events TO service_role;
ALTER TABLE public.physical_count_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read physical_count_events"
  ON public.physical_count_events FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "org members write physical_count_events"
  ON public.physical_count_events FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "service_role all physical_count_events"
  ON public.physical_count_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_pc_events_count ON public.physical_count_events(count_id, created_at);

-- 4. physical_count_freeze_movements (watermark rows)
CREATE TABLE public.physical_count_freeze_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL REFERENCES public.physical_counts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  last_movement_id uuid,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (count_id, warehouse_id, product_id)
);

GRANT SELECT, INSERT ON public.physical_count_freeze_movements TO authenticated;
GRANT ALL ON public.physical_count_freeze_movements TO service_role;
ALTER TABLE public.physical_count_freeze_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org read pcfm"
  ON public.physical_count_freeze_movements FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "service_role all pcfm"
  ON public.physical_count_freeze_movements FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. physical_count_tolerance_policies
CREATE TABLE public.physical_count_tolerance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid,
  category_id uuid,
  variance_pct numeric,
  variance_value numeric,
  require_recount boolean NOT NULL DEFAULT false,
  require_manager_approval boolean NOT NULL DEFAULT true,
  require_freeze boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.physical_count_tolerance_policies TO authenticated;
GRANT ALL ON public.physical_count_tolerance_policies TO service_role;
ALTER TABLE public.physical_count_tolerance_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org read tolerance"
  ON public.physical_count_tolerance_policies FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "org write tolerance"
  ON public.physical_count_tolerance_policies FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_business_access WHERE user_id = auth.uid()));

CREATE POLICY "service_role all tolerance"
  ON public.physical_count_tolerance_policies FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. updated_at + immutability triggers
CREATE OR REPLACE FUNCTION public._touch_physical_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER trg_touch_physical_counts BEFORE UPDATE ON public.physical_counts
  FOR EACH ROW EXECUTE FUNCTION public._touch_physical_count();
CREATE TRIGGER trg_touch_physical_count_lines BEFORE UPDATE ON public.physical_count_lines
  FOR EACH ROW EXECUTE FUNCTION public._touch_physical_count();
CREATE TRIGGER trg_touch_pc_tolerance BEFORE UPDATE ON public.physical_count_tolerance_policies
  FOR EACH ROW EXECUTE FUNCTION public._touch_physical_count();

CREATE OR REPLACE FUNCTION public._pc_immutable_after_post() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('posted','cancelled','superseded') AND TG_OP = 'UPDATE' THEN
    -- Only allow narrow field changes (superseded_by pointer)
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (OLD.state = 'posted' AND NEW.state = 'superseded') THEN
      RAISE EXCEPTION 'physical_count % is % and cannot be mutated', OLD.id, OLD.state
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_pc_immutable BEFORE UPDATE ON public.physical_counts
  FOR EACH ROW EXECUTE FUNCTION public._pc_immutable_after_post();
