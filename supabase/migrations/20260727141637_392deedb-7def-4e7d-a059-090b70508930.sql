-- ============================================================================
-- Gate 0 — Document catalog completion + output-target correction.
--
-- Three defects are corrected here:
--
-- 1. Missing document kinds. Five business documents that the remaining
--    print call sites need had no row in `document_kinds`, so any attempt to
--    route them raised `document_kind_not_found`.
--
-- 2. Dead target seeds. The Wave 4 seed migration attached thermal and label
--    targets using kind codes (`pos_receipt`, `pos_kitchen_ticket`, ...) that
--    never existed - the real codes are dot-separated (`pos.receipt_customer`).
--    Every predicate matched zero rows, so EVERY kind ended up with a single
--    `pdf/download` target. A POS receipt dispatched through the pipeline
--    would silently become a PDF download instead of a thermal print.
--
-- 3. Non-canonical hardware roles. The dead seed also used `receipt_thermal`,
--    which is not in the HARDWARE_ROLES vocabulary
--    (electron/hardware/types.ts). Canonical roles are used below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Missing document kinds.
-- ---------------------------------------------------------------------------
INSERT INTO public.document_kinds
  (code, label, domain, legal_class, default_media_class, default_intents, allowed_formats, requires_party)
VALUES
  ('sales.return',          'Sales Return / RMA',   'sales',     'contractual', 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],       true),
  ('purchases.return',      'Purchase Return',      'purchases', 'contractual', 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'],       true),
  ('purchases.statement',   'Vendor Statement',     'purchases', 'none',        'a4_portrait', ARRAY['view','download','email'],         ARRAY['pdf','csv'], true),
  ('pos.drawer_slip',       'Cash Drawer Slip',     'pos',       'none',        'thermal_80',  ARRAY['print'],                           ARRAY['escpos'],    false),
  ('inventory.product_label','Product Label',       'inventory', 'none',        'label_50x30', ARRAY['print'],                           ARRAY['zpl','epl'], false)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. A system-scope default intent for every kind that lacks one.
--    Idempotent: covers both the five new kinds and any future gap.
-- ---------------------------------------------------------------------------
INSERT INTO public.output_intents (document_kind, scope, scenario, name, description, priority)
SELECT dk.code, 'system', 'default',
       'System default - ' || dk.code,
       'Default output routing (Gate 0 catalog completion)', 100
FROM public.document_kinds dk
WHERE NOT EXISTS (
  SELECT 1 FROM public.output_intents i
  WHERE i.document_kind = dk.code AND i.scope = 'system' AND i.scenario = 'default'
);

-- ---------------------------------------------------------------------------
-- 3a. Thermal print target for POS kinds (the seed that never fired).
--     `pos.kitchen_ticket` routes to the kitchen printer, not the till.
-- ---------------------------------------------------------------------------
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'escpos', 'print',
       CASE i.document_kind
         WHEN 'pos.kitchen_ticket' THEN 'kitchen_printer'
         WHEN 'pos.drawer_slip'    THEN 'cash_drawer'
         ELSE 'receipt_printer'
       END,
       1, 10
FROM public.output_intents i
WHERE i.scope = 'system'
  AND i.scenario = 'default'
  AND i.document_kind IN (
    'pos.receipt_customer', 'pos.receipt_merchant',
    'pos.kitchen_ticket',   'pos.drawer_slip'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t
    WHERE t.intent_id = i.id AND t.medium = 'escpos'
  );

-- ---------------------------------------------------------------------------
-- 3b. ZPL label target for label kinds (the other seed that never fired).
-- ---------------------------------------------------------------------------
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'zpl', 'print', 'label_printer', 1, 10
FROM public.output_intents i
WHERE i.scope = 'system'
  AND i.scenario = 'default'
  AND i.document_kind IN (
    'inventory.item_barcode', 'inventory.price_label', 'inventory.shelf_label',
    'inventory.product_label', 'inventory.pallet_label', 'inventory.shipping_label',
    'mfg.fg_label'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t
    WHERE t.intent_id = i.id AND t.medium = 'zpl'
  );

-- ---------------------------------------------------------------------------
-- 3c. Baseline pdf/download target for the new kinds that have none.
-- ---------------------------------------------------------------------------
INSERT INTO public.output_intent_targets (intent_id, medium, disposition, hardware_role, copies, priority)
SELECT i.id, 'pdf', 'download', NULL, 1, 100
FROM public.output_intents i
JOIN public.document_kinds dk ON dk.code = i.document_kind
WHERE i.scope = 'system'
  AND i.scenario = 'default'
  AND 'pdf' = ANY (dk.allowed_formats)
  AND NOT EXISTS (
    SELECT 1 FROM public.output_intent_targets t WHERE t.intent_id = i.id
  );

-- ---------------------------------------------------------------------------
-- 4. Scenario fallback in the resolver.
--
--    Previously the resolver matched `scenario = p_scenario` exactly, so a
--    named scenario such as 'on_close' raised `no_output_intent_matched`
--    even though a perfectly good 'default' intent existed. Enterprise
--    routing tables are layered: a named scenario overrides the default,
--    and falls back to it when unconfigured.
--
--    Precedence is now: scenario-exact before default, then
--    branch > organization > tenant > system, then priority ASC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_output_intent(
  p_document_kind   text,
  p_organization_id uuid DEFAULT NULL,
  p_branch_id       uuid DEFAULT NULL,
  p_scenario        text DEFAULT 'default'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_intent  public.output_intents%ROWTYPE;
  v_targets JSONB;
BEGIN
  SELECT * INTO v_intent
  FROM public.output_intents
  WHERE document_kind = p_document_kind
    AND scenario IN (p_scenario, 'default')
    AND is_active = TRUE
    AND (
      (scope = 'branch'       AND organization_id = p_organization_id AND branch_id = p_branch_id) OR
      (scope = 'organization' AND organization_id = p_organization_id) OR
      (scope = 'system')
    )
  ORDER BY
    -- An intent configured for the requested scenario always wins over the
    -- catch-all default, regardless of scope.
    CASE WHEN scenario = p_scenario THEN 0 ELSE 1 END,
    CASE scope
      WHEN 'branch'       THEN 1
      WHEN 'organization' THEN 2
      WHEN 'tenant'       THEN 3
      WHEN 'system'       THEN 4
    END,
    priority ASC
  LIMIT 1;

  IF v_intent.id IS NULL THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'no_intent_matched');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',            t.id,
      'medium',        t.medium,
      'disposition',   t.disposition,
      'hardware_role', t.hardware_role,
      'template_code', t.template_code,
      'copies',        t.copies,
      'priority',      t.priority,
      'params',        t.params
    ) ORDER BY t.priority ASC
  ), '[]'::jsonb)
  INTO v_targets
  FROM public.output_intent_targets t
  WHERE t.intent_id = v_intent.id AND t.is_active = TRUE;

  RETURN jsonb_build_object(
    'resolved',    true,
    'intent_id',   v_intent.id,
    'intent_name', v_intent.name,
    'scope',       v_intent.scope,
    'scenario',    v_intent.scenario,
    'targets',     v_targets
  );
END;
$function$;