CREATE TABLE IF NOT EXISTS public.product_tax_localization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  jurisdiction text NOT NULL DEFAULT 'KE',
  classification_code text,
  item_code text,
  unit_code text NOT NULL DEFAULT 'U',
  packaging_unit text NOT NULL DEFAULT 'CT',
  origin_country text NOT NULL DEFAULT 'KE',
  registration_status text NOT NULL DEFAULT 'pending',
  registered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_tax_localization_unique UNIQUE (product_id, jurisdiction),
  CONSTRAINT product_tax_localization_status_chk
    CHECK (registration_status IN ('pending','registered','failed','not_applicable'))
);

COMMENT ON TABLE public.product_tax_localization IS
  'Per-jurisdiction fiscal/tax metadata for a product (KRA eTIMS today). The product master must never carry one country''s tax vocabulary.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_tax_localization TO authenticated;
GRANT ALL ON public.product_tax_localization TO service_role;

ALTER TABLE public.product_tax_localization ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ptl_select_org_members" ON public.product_tax_localization;
CREATE POLICY "ptl_select_org_members" ON public.product_tax_localization
FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "ptl_write_org_members" ON public.product_tax_localization;
CREATE POLICY "ptl_write_org_members" ON public.product_tax_localization
FOR ALL TO authenticated
USING (public.is_org_member(auth.uid(), organization_id))
WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS trg_ptl_updated_at ON public.product_tax_localization;
CREATE TRIGGER trg_ptl_updated_at
BEFORE UPDATE ON public.product_tax_localization
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_ptl_product ON public.product_tax_localization (product_id);
CREATE INDEX IF NOT EXISTS idx_ptl_business_status ON public.product_tax_localization (business_id, registration_status);

-- Backfill from the product master
INSERT INTO public.product_tax_localization (
  organization_id, business_id, product_id, jurisdiction,
  classification_code, item_code, unit_code, packaging_unit,
  origin_country, registration_status, registered_at
)
SELECT p.organization_id, p.business_id, p.id,
       COALESCE(NULLIF(p.etims_origin_country,''), NULLIF(p.etims_country_origin,''), 'KE'),
       NULLIF(p.etims_classification_code,''),
       NULLIF(p.etims_item_code,''),
       COALESCE(NULLIF(p.etims_unit_code,''), 'U'),
       COALESCE(NULLIF(p.etims_packaging_unit,''), 'CT'),
       COALESCE(NULLIF(p.etims_origin_country,''), NULLIF(p.etims_country_origin,''), 'KE'),
       CASE WHEN p.etims_registration_status IN ('pending','registered','failed','not_applicable')
            THEN p.etims_registration_status ELSE 'pending' END,
       p.etims_registered_at
  FROM public.products p
 WHERE NOT EXISTS (
   SELECT 1 FROM public.product_tax_localization l
    WHERE l.product_id = p.id
 );

-- Write seam
CREATE OR REPLACE FUNCTION public.upsert_product_tax_localization(
  p_product_id uuid,
  p_payload jsonb
)
RETURNS public.product_tax_localization
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_biz uuid;
  v_jur text;
  v_row public.product_tax_localization;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PRODUCT_LOCALIZATION_INVALID: payload must be a JSON object' USING ERRCODE = 'P0001';
  END IF;

  SELECT organization_id, business_id INTO v_org, v_biz
    FROM public.products WHERE id = p_product_id;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: product does not exist' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._assert_org_member(v_org);

  v_jur := COALESCE(NULLIF(btrim(p_payload->>'jurisdiction'),''),
                    NULLIF(btrim(p_payload->>'origin_country'),''), 'KE');

  INSERT INTO public.product_tax_localization (
    organization_id, business_id, product_id, jurisdiction,
    classification_code, item_code, unit_code, packaging_unit,
    origin_country, registration_status, registered_at
  ) VALUES (
    v_org, v_biz, p_product_id, v_jur,
    NULLIF(btrim(COALESCE(p_payload->>'classification_code','')),''),
    NULLIF(btrim(COALESCE(p_payload->>'item_code','')),''),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'unit_code','')),''), 'U'),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'packaging_unit','')),''), 'CT'),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'origin_country','')),''), v_jur),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'registration_status','')),''), 'pending'),
    NULLIF(p_payload->>'registered_at','')::timestamptz
  )
  ON CONFLICT (product_id, jurisdiction) DO UPDATE SET
    classification_code = COALESCE(NULLIF(btrim(COALESCE(EXCLUDED.classification_code,'')),''), public.product_tax_localization.classification_code),
    item_code           = COALESCE(EXCLUDED.item_code, public.product_tax_localization.item_code),
    unit_code           = EXCLUDED.unit_code,
    packaging_unit      = EXCLUDED.packaging_unit,
    origin_country      = EXCLUDED.origin_country,
    registration_status = EXCLUDED.registration_status,
    registered_at       = COALESCE(EXCLUDED.registered_at, public.product_tax_localization.registered_at),
    updated_at          = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_product_tax_localization(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_product_tax_localization(uuid, jsonb) TO authenticated, service_role;

-- Read seam
CREATE OR REPLACE FUNCTION public.resolve_product_tax_localization(
  p_product_id uuid,
  p_jurisdiction text DEFAULT NULL
)
RETURNS public.product_tax_localization
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.* FROM public.product_tax_localization l
   WHERE l.product_id = p_product_id
     AND (p_jurisdiction IS NULL OR l.jurisdiction = p_jurisdiction)
   ORDER BY (l.jurisdiction = COALESCE(p_jurisdiction, l.jurisdiction)) DESC, l.jurisdiction
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_product_tax_localization(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_tax_localization(uuid, text) TO authenticated, service_role;