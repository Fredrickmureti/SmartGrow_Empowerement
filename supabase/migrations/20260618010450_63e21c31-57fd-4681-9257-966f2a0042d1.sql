-- Wave B2.2 — seed default `product_label` template per organization.
--
-- The new template-driven label path (printLabelByTemplate in
-- src/services/printing/labelDispatch.ts) needs a row in label_templates
-- keyed by ('product_label', org-scope) to resolve a body. Without a seed,
-- every product-label print on an org that hasn't customized templates
-- returns {success:false, error:'no label template registered'}.
--
-- Strategy: ship a generic ZPL default keyed at the org level (branch_id
-- IS NULL). Orgs that need an ESC-POS or branch-specific version override
-- at the org or branch tier — the existing resolver fallback chain handles
-- precedence. Idempotent backfill + AFTER-INSERT trigger keeps new orgs
-- correct going forward.

-- (1) Backfill existing organizations with a default product_label template.
INSERT INTO public.label_templates
  (org_id, branch_id, kind, template_key, name, engine, body,
   width_mm, height_mm, is_default, version, active)
SELECT
  o.id,
  NULL::uuid,
  'product',
  'product_label',
  'Product Label (Default)',
  'zpl'::public.label_engine,
  -- Generic ZPL: product name, Code 128 barcode, SKU sub-line.
  -- 4×6 in (101 × 152 mm) is the most common thermal-label dimension and
  -- is what Zebra ZT/ZD printers default to. Tokens are substituted by
  -- renderTemplateBody() in labelDispatch.ts.
  E'^XA\n^CF0,28\n^FO40,30^FD{{name}}^FS\n^FO40,80^BCN,100,Y,N,N^FD{{barcode}}^FS\n^FO40,210^A0N,22,22^FDSKU: {{sku}}^FS\n^XZ',
  101,
  152,
  true,
  1,
  true
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM public.label_templates lt
  WHERE lt.org_id = o.id
    AND lt.branch_id IS NULL
    AND lt.template_key = 'product_label'
);

-- (2) AFTER INSERT trigger on organizations to auto-seed new orgs.
CREATE OR REPLACE FUNCTION public.tg_seed_default_label_templates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body,
     width_mm, height_mm, is_default, version, active)
  VALUES (
    NEW.id,
    NULL,
    'product',
    'product_label',
    'Product Label (Default)',
    'zpl'::public.label_engine,
    E'^XA\n^CF0,28\n^FO40,30^FD{{name}}^FS\n^FO40,80^BCN,100,Y,N,N^FD{{barcode}}^FS\n^FO40,210^A0N,22,22^FDSKU: {{sku}}^FS\n^XZ',
    101,
    152,
    true,
    1,
    true
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_seed_default_label_templates() IS
  'Wave B2.2: seeds the default product_label template when a new organization is created. ON CONFLICT DO NOTHING preserves any pre-existing template (e.g. seeded by a localization pack).';

DROP TRIGGER IF EXISTS trg_seed_default_label_templates ON public.organizations;
CREATE TRIGGER trg_seed_default_label_templates
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_seed_default_label_templates();
