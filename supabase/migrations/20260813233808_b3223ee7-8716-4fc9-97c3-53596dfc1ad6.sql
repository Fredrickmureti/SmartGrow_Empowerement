-- Fiscal jurisdiction = the tax authority the BUSINESS files with.
-- Country of origin = where the goods came from. Conflating them filed an
-- imported product under the supplier's country, where no fiscal integration
-- (eTIMS reads jurisdiction 'KE') would ever find it again.
CREATE OR REPLACE FUNCTION public.resolve_fiscal_jurisdiction(p_business_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(btrim(b.country), ''), 'KE')
    FROM public.businesses b
   WHERE b.id = p_business_id
$$;

REVOKE ALL ON FUNCTION public.resolve_fiscal_jurisdiction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fiscal_jurisdiction(uuid) TO authenticated, service_role;

-- Repair rows filed under the country of origin.
-- Keep the most complete row per product, move it to the business jurisdiction,
-- and drop the now-duplicate siblings.
WITH ranked AS (
  SELECT l.id,
         l.product_id,
         public.resolve_fiscal_jurisdiction(l.business_id) AS target_jur,
         row_number() OVER (
           PARTITION BY l.product_id
           ORDER BY (l.jurisdiction = public.resolve_fiscal_jurisdiction(l.business_id)) DESC,
                    (l.registration_status = 'registered') DESC,
                    (l.classification_code IS NOT NULL) DESC,
                    l.created_at
         ) AS rn
    FROM public.product_tax_localization l
)
DELETE FROM public.product_tax_localization l
 USING ranked r
 WHERE l.id = r.id AND r.rn > 1;

WITH ranked AS (
  SELECT l.id, public.resolve_fiscal_jurisdiction(l.business_id) AS target_jur
    FROM public.product_tax_localization l
)
UPDATE public.product_tax_localization l
   SET jurisdiction = r.target_jur,
       updated_at = now()
  FROM ranked r
 WHERE l.id = r.id
   AND l.jurisdiction IS DISTINCT FROM r.target_jur;

-- Write seam: jurisdiction never derives from origin_country any more.
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

  -- Explicit jurisdiction wins (multi-jurisdiction filers), otherwise the
  -- business's own tax authority. origin_country is NOT a jurisdiction.
  v_jur := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'jurisdiction','')),''),
                    public.resolve_fiscal_jurisdiction(v_biz));

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
