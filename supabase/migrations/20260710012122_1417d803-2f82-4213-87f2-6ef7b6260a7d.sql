
-- =============================================================================
-- Scrap / Waste — reason master data, attachments, domain events, extra SoD
-- =============================================================================

-- 1. scrap_reasons ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrap_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  offset_account_purpose text NOT NULL DEFAULT 'shrinkage',
  requires_attachment boolean NOT NULL DEFAULT false,
  requires_approval_above numeric NOT NULL DEFAULT 0,
  insurance_claim_flag boolean NOT NULL DEFAULT false,
  quality_hold_flag boolean NOT NULL DEFAULT false,
  regulatory_reporting_flag boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scrap_reasons TO authenticated;
GRANT ALL ON public.scrap_reasons TO service_role;

ALTER TABLE public.scrap_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scrap_reasons_read ON public.scrap_reasons;
CREATE POLICY scrap_reasons_read ON public.scrap_reasons
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_reasons.organization_id
    )
  );

DROP POLICY IF EXISTS scrap_reasons_write ON public.scrap_reasons;
CREATE POLICY scrap_reasons_write ON public.scrap_reasons
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_reasons.organization_id
         AND uba.role IN ('owner','admin','manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_reasons.organization_id
         AND uba.role IN ('owner','admin','manager')
    )
  );

CREATE INDEX IF NOT EXISTS idx_scrap_reasons_org ON public.scrap_reasons(organization_id, is_active, sort_order);

-- updated_at trigger --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS scrap_reasons_touch_updated_at ON public.scrap_reasons;
CREATE TRIGGER scrap_reasons_touch_updated_at
  BEFORE UPDATE ON public.scrap_reasons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- seed defaults per organization -------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_default_scrap_reasons(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.scrap_reasons
    (organization_id, code, label, description, offset_account_purpose,
     requires_attachment, insurance_claim_flag, quality_hold_flag,
     regulatory_reporting_flag, sort_order)
  VALUES
    (p_org_id, 'damaged',        'Damaged',        'Physically damaged goods (breakage, spillage, mishandling).', 'shrinkage', true,  true,  false, false, 10),
    (p_org_id, 'expired',        'Expired',        'Past shelf-life / best-before date.', 'shrinkage', false, false, false, true,  20),
    (p_org_id, 'defective',      'Defective',      'Manufacturing defect discovered post-receipt.', 'shrinkage', true, false, true,  false, 30),
    (p_org_id, 'obsolete',       'Obsolete',       'Slow-moving or superseded stock written off.', 'shrinkage', false, false, false, false, 40),
    (p_org_id, 'quality_reject', 'Quality reject', 'Failed inbound or in-line quality inspection.', 'shrinkage', true,  false, true,  false, 50),
    (p_org_id, 'theft',          'Theft / loss',   'Confirmed or unrecovered inventory shrinkage.', 'shrinkage', false, true,  false, false, 60),
    (p_org_id, 'hazardous',      'Hazardous disposal', 'Regulated waste requiring certified disposal.', 'shrinkage', true, false, false, true, 70),
    (p_org_id, 'sample',         'Sample / giveaway', 'Marketing sample or promotional giveaway.', 'shrinkage', false, false, false, false, 80),
    (p_org_id, 'other',          'Other',          'Other reason (require notes).', 'shrinkage', false, false, false, false, 999)
  ON CONFLICT (organization_id, code) DO NOTHING;
END; $$;

-- backfill for existing orgs
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.ensure_default_scrap_reasons(r.id);
  END LOOP;
END $$;

-- 2. scrap_attachments -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scrap_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  scrap_id uuid NOT NULL REFERENCES public.stock_adjustments(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  kind text NOT NULL DEFAULT 'photo'
    CHECK (kind IN ('photo','disposal_certificate','insurance_form','other')),
  file_name text,
  content_type text,
  size_bytes bigint,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scrap_attachments TO authenticated;
GRANT ALL ON public.scrap_attachments TO service_role;

ALTER TABLE public.scrap_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scrap_attachments_read ON public.scrap_attachments;
CREATE POLICY scrap_attachments_read ON public.scrap_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_attachments.organization_id
    )
  );

DROP POLICY IF EXISTS scrap_attachments_insert ON public.scrap_attachments;
CREATE POLICY scrap_attachments_insert ON public.scrap_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_attachments.organization_id
    )
  );

DROP POLICY IF EXISTS scrap_attachments_delete ON public.scrap_attachments;
CREATE POLICY scrap_attachments_delete ON public.scrap_attachments
  FOR DELETE TO authenticated
  USING (
    uploaded_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
         AND uba.organization_id = scrap_attachments.organization_id
         AND uba.role IN ('owner','admin','manager')
    )
  );

CREATE INDEX IF NOT EXISTS idx_scrap_attachments_scrap ON public.scrap_attachments(scrap_id);

-- 3. Emit scrap.posted / scrap.reversed into outbox --------------------------
CREATE OR REPLACE FUNCTION public.emit_scrap_lifecycle_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
  v_total numeric;
BEGIN
  IF NEW.adjustment_type <> 'scrap' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('approved','posted') AND OLD.status NOT IN ('approved','posted') THEN
    v_event := 'scrap.posted';
  ELSIF NEW.status = 'reversed' AND OLD.status <> 'reversed' THEN
    v_event := 'scrap.reversed';
  ELSE
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(ABS(quantity_adjustment) * COALESCE(unit_cost, 0)), 0)
    INTO v_total
    FROM public.stock_adjustment_items
   WHERE adjustment_id = NEW.id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id,
    NEW.branch_id,
    NEW.warehouse_id,
    v_event,
    'stock_adjustment',
    NEW.id,
    jsonb_build_object(
      'adjustment_id', NEW.id,
      'adjustment_number', NEW.adjustment_number,
      'business_id', NEW.business_id,
      'branch_id', NEW.branch_id,
      'warehouse_id', NEW.warehouse_id,
      'reason', NEW.reason,
      'total_value', v_total,
      'from_status', OLD.status,
      'to_status', NEW.status
    ),
    'scrap:' || NEW.id::text || ':' || v_event,
    COALESCE(NEW.approved_by, NEW.created_by),
    'scrap_lifecycle'
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS emit_scrap_lifecycle_events ON public.stock_adjustments;
CREATE TRIGGER emit_scrap_lifecycle_events
  AFTER UPDATE OF status ON public.stock_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.emit_scrap_lifecycle_events();

-- 4. Seed scrap.reverse self-action policy for every org ---------------------
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role)
SELECT o.id, 'scrap.reverse', 'block', NULL
  FROM public.organizations o
 WHERE NOT EXISTS (
    SELECT 1 FROM public.self_action_policy p
     WHERE p.organization_id = o.id AND p.action_key = 'scrap.reverse'
 );

COMMENT ON TABLE public.scrap_reasons IS
  'Per-organization master list of scrap/waste reasons. Drives UX picker, GL offset resolution, approval thresholds, insurance/quality/regulatory routing.';
COMMENT ON TABLE public.scrap_attachments IS
  'Attachments (photos, disposal certificates, insurance forms) linked to a scrap stock_adjustments header.';
COMMENT ON FUNCTION public.emit_scrap_lifecycle_events IS
  'Emits scrap.posted / scrap.reversed into business_event_outbox when a scrap stock_adjustment transitions status. Idempotent per (id, event_type).';
