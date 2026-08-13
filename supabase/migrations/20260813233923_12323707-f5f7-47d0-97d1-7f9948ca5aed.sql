-- create_product_with_opening_stock_atomic still derived the tax jurisdiction
-- from the country of origin. Route it through the same seam as every other
-- write so one product can never exist under two jurisdictions.
CREATE OR REPLACE FUNCTION public._product_localization_from_payload(p_product jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    jsonb_strip_nulls(
      COALESCE(p_product->'localization', '{}'::jsonb)
      || jsonb_build_object(
        'classification_code', COALESCE(
          NULLIF(btrim(COALESCE(p_product->'localization'->>'classification_code','')),''),
          NULLIF(btrim(COALESCE(p_product->>'etims_classification_code','')),'')),
        'unit_code', COALESCE(
          NULLIF(btrim(COALESCE(p_product->'localization'->>'unit_code','')),''),
          NULLIF(btrim(COALESCE(p_product->>'etims_unit_code','')),'')),
        'packaging_unit', COALESCE(
          NULLIF(btrim(COALESCE(p_product->'localization'->>'packaging_unit','')),''),
          NULLIF(btrim(COALESCE(p_product->>'etims_packaging_unit','')),'')),
        'origin_country', COALESCE(
          NULLIF(btrim(COALESCE(p_product->'localization'->>'origin_country','')),''),
          NULLIF(btrim(COALESCE(p_product->>'etims_origin_country','')),''),
          NULLIF(btrim(COALESCE(p_product->>'etims_country_origin','')),''))
      )
    ),
    '{}'::jsonb)
$$;
