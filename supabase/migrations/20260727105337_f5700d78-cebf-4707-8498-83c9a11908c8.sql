
-- =========================================================================
-- Wave 4: Output Intent + Policy Resolver
-- =========================================================================

-- Enums -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.output_scope AS ENUM ('system','tenant','organization','branch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.output_medium AS ENUM ('pdf','escpos','zpl','html');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.output_disposition AS ENUM ('print','email','download','archive','fiscal','webhook');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- output_intents ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.output_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_kind TEXT NOT NULL REFERENCES public.document_kinds(code) ON UPDATE CASCADE,
  scope public.output_scope NOT NULL,
  tenant_id UUID NULL,
  organization_id UUID NULL,
  branch_id UUID NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  scenario TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,  -- optional matcher (e.g. { amount_gte: 1000 })
  priority INT NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT output_intents_scope_keys CHECK (
    (scope = 'system'       AND organization_id IS NULL AND branch_id IS NULL) OR
    (scope = 'tenant'       AND tenant_id IS NOT NULL) OR
    (scope = 'organization' AND organization_id IS NOT NULL AND branch_id IS NULL) OR
    (scope = 'branch'       AND organization_id IS NOT NULL AND branch_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS output_intents_lookup_idx
  ON public.output_intents (document_kind, scope, organization_id, branch_id, scenario, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.output_intents TO authenticated;
GRANT ALL ON public.output_intents TO service_role;

ALTER TABLE public.output_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY output_intents_read ON public.output_intents
FOR SELECT TO authenticated
USING (
  scope = 'system'
  OR (organization_id IS NOT NULL AND public.is_org_member(auth.uid(), organization_id))
);

CREATE POLICY output_intents_write_org ON public.output_intents
FOR ALL TO authenticated
USING (
  scope IN ('organization','branch')
  AND organization_id IS NOT NULL
  AND public.has_org_role(auth.uid(), organization_id, 'admin')
)
WITH CHECK (
  scope IN ('organization','branch')
  AND organization_id IS NOT NULL
  AND public.has_org_role(auth.uid(), organization_id, 'admin')
);

-- output_intent_targets ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.output_intent_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES public.output_intents(id) ON DELETE CASCADE,
  medium public.output_medium NOT NULL,
  disposition public.output_disposition NOT NULL,
  hardware_role TEXT NULL,           -- role alias, e.g. 'receipt_thermal', 'fiscal_a4', 'label_zpl'
  template_code TEXT NULL,           -- optional pin to a specific document_template_ast.code
  copies SMALLINT NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 20),
  priority INT NOT NULL DEFAULT 100,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS output_intent_targets_intent_idx
  ON public.output_intent_targets (intent_id, priority);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.output_intent_targets TO authenticated;
GRANT ALL ON public.output_intent_targets TO service_role;

ALTER TABLE public.output_intent_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY output_intent_targets_read ON public.output_intent_targets
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.output_intents i
  WHERE i.id = output_intent_targets.intent_id
    AND (i.scope = 'system'
         OR (i.organization_id IS NOT NULL AND public.is_org_member(auth.uid(), i.organization_id)))
));

CREATE POLICY output_intent_targets_write ON public.output_intent_targets
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.output_intents i
  WHERE i.id = output_intent_targets.intent_id
    AND i.scope IN ('organization','branch')
    AND i.organization_id IS NOT NULL
    AND public.has_org_role(auth.uid(), i.organization_id, 'admin')
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.output_intents i
  WHERE i.id = output_intent_targets.intent_id
    AND i.scope IN ('organization','branch')
    AND i.organization_id IS NOT NULL
    AND public.has_org_role(auth.uid(), i.organization_id, 'admin')
));

-- output_dispatch_log -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.output_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NULL REFERENCES public.documents(id) ON DELETE SET NULL,
  document_kind TEXT NOT NULL,
  organization_id UUID NOT NULL,
  branch_id UUID NULL,
  scenario TEXT NOT NULL DEFAULT 'default',
  intent_id UUID NULL REFERENCES public.output_intents(id) ON DELETE SET NULL,
  resolved_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by UUID NULL,
  triggered_source TEXT NULL,  -- 'business_event' | 'manual' | 'reprint' | 'api'
  status TEXT NOT NULL DEFAULT 'resolved', -- resolved | dispatched | failed | partial
  error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS output_dispatch_log_doc_idx
  ON public.output_dispatch_log (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS output_dispatch_log_org_idx
  ON public.output_dispatch_log (organization_id, created_at DESC);

GRANT SELECT ON public.output_dispatch_log TO authenticated;
GRANT ALL ON public.output_dispatch_log TO service_role;

ALTER TABLE public.output_dispatch_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY output_dispatch_log_read ON public.output_dispatch_log
FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

-- updated_at triggers -----------------------------------------------------
DROP TRIGGER IF EXISTS trg_output_intents_touch ON public.output_intents;
CREATE TRIGGER trg_output_intents_touch
BEFORE UPDATE ON public.output_intents
FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

DROP TRIGGER IF EXISTS trg_output_intent_targets_touch ON public.output_intent_targets;
CREATE TRIGGER trg_output_intent_targets_touch
BEFORE UPDATE ON public.output_intent_targets
FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- =========================================================================
-- Resolver RPC: returns the winning intent + ordered targets for a request
-- =========================================================================
CREATE OR REPLACE FUNCTION public.resolve_output_intent(
  p_document_kind TEXT,
  p_organization_id UUID,
  p_branch_id UUID DEFAULT NULL,
  p_scenario TEXT DEFAULT 'default'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent public.output_intents%ROWTYPE;
  v_targets JSONB;
BEGIN
  -- Precedence: branch > organization > tenant > system, then priority ASC
  SELECT * INTO v_intent
  FROM public.output_intents
  WHERE document_kind = p_document_kind
    AND scenario = p_scenario
    AND is_active = TRUE
    AND (
      (scope = 'branch'       AND organization_id = p_organization_id AND branch_id = p_branch_id) OR
      (scope = 'organization' AND organization_id = p_organization_id) OR
      (scope = 'system')
    )
  ORDER BY
    CASE scope
      WHEN 'branch' THEN 1
      WHEN 'organization' THEN 2
      WHEN 'tenant' THEN 3
      WHEN 'system' THEN 4
    END,
    priority ASC
  LIMIT 1;

  IF v_intent.id IS NULL THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'no_intent_matched');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'medium', t.medium,
      'disposition', t.disposition,
      'hardware_role', t.hardware_role,
      'template_code', t.template_code,
      'copies', t.copies,
      'priority', t.priority,
      'params', t.params
    ) ORDER BY t.priority ASC
  ), '[]'::jsonb)
  INTO v_targets
  FROM public.output_intent_targets t
  WHERE t.intent_id = v_intent.id AND t.is_active = TRUE;

  RETURN jsonb_build_object(
    'resolved', true,
    'intent_id', v_intent.id,
    'intent_name', v_intent.name,
    'scope', v_intent.scope,
    'scenario', v_intent.scenario,
    'targets', v_targets
  );
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_output_intent(TEXT, UUID, UUID, TEXT) TO authenticated, service_role;

-- =========================================================================
-- Seed: system-default intents for every document_kind
-- pdf/download for all, plus escpos/receipt_thermal for POS receipts,
-- and zpl/label_zpl for shipment labels & product labels.
-- =========================================================================
INSERT INTO public.output_intents (document_kind, scope, scenario, name, description, priority)
SELECT dk.code, 'system', 'default',
       'System default — ' || dk.code,
       'Default output routing seeded during Wave 4', 100
FROM public.document_kinds dk
ON CONFLICT DO NOTHING;

-- Default PDF/download target for every system intent
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'pdf', 'download', NULL, 1, 100
FROM public.output_intents i
WHERE i.scope = 'system'
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t
    WHERE t.intent_id = i.id AND t.medium = 'pdf' AND t.disposition = 'download'
  );

-- Thermal receipt target for POS-ish kinds
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'escpos', 'print', 'receipt_thermal', 1, 50
FROM public.output_intents i
JOIN public.document_kinds dk ON dk.code = i.document_kind
WHERE i.scope = 'system'
  AND dk.code IN ('pos_receipt','pos_refund_receipt','pos_shift_report','pos_kitchen_ticket')
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t
    WHERE t.intent_id = i.id AND t.medium = 'escpos'
  );

-- Label target for label-ish kinds
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'zpl', 'print', 'label_zpl', 1, 50
FROM public.output_intents i
JOIN public.document_kinds dk ON dk.code = i.document_kind
WHERE i.scope = 'system'
  AND dk.code IN ('shipment_label','product_label','shelf_label','gs1_label')
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t
    WHERE t.intent_id = i.id AND t.medium = 'zpl'
  );
