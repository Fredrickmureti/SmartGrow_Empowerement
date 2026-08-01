-- A′ step 2: resolver contract (GS1 + GTIN variants + ambiguity + branch)
DROP FUNCTION IF EXISTS public.resolve_product_identity(uuid, text);

CREATE OR REPLACE FUNCTION public.resolve_product_identity(
  p_business_id uuid,
  p_code text,
  p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE(
  product_id uuid, product_name text, sku text, identifier_id uuid,
  matched_kind product_identifier_kind, matched_code text,
  packaging_id uuid, packaging_name text, qty_in_base_uom numeric,
  base_uom_id uuid, is_base_unit boolean, match_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_cands text[];
  v_gtin text;
  v_digits text;
  v_ident record;
  v_pid uuid;
  v_count int := 0;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN;
  END IF;
  IF length(v_code) = 0 THEN RETURN; END IF;

  v_cands := ARRAY[v_norm];

  -- GS1 element string: leading AI (01) carries a 14-digit GTIN.
  IF v_norm ~ '^\(?01\)?[0-9]{14}' THEN
    v_gtin := substring(replace(replace(v_norm, '(', ''), ')', '') FROM 3 FOR 14);
    v_cands := v_cands || v_gtin;
  END IF;

  -- GTIN-8/12/13/14 are the same number with different zero padding.
  v_digits := CASE WHEN v_norm ~ '^[0-9]+$' THEN v_norm ELSE coalesce(v_gtin, '') END;
  IF v_digits ~ '^[0-9]{8,14}$' THEN
    v_cands := v_cands
      || ltrim(v_digits, '0')
      || lpad(ltrim(v_digits, '0'), 13, '0')
      || lpad(ltrim(v_digits, '0'), 14, '0');
  END IF;

  SELECT count(*) INTO v_count
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands);

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
   ORDER BY (pi.code_norm = v_norm) DESC, pi.is_primary DESC, pi.created_at
   LIMIT 1;

  IF v_ident.product_id IS NULL THEN
    -- SKU fallback: the product's own code is a legitimate base-unit identifier.
    SELECT p.id INTO v_pid
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.is_active = true
       AND p.sku IS NOT NULL
       AND upper(btrim(p.sku)) = ANY(v_cands)
     LIMIT 1;
    IF v_pid IS NULL THEN RETURN; END IF;
    v_count := 1;
  ELSE
    v_pid := v_ident.product_id;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name::text,
    p.sku::text,
    v_ident.id,
    COALESCE(v_ident.kind, 'sku'::public.product_identifier_kind),
    COALESCE(v_ident.code, p.sku)::text,
    pk.id,
    pk.name::text,
    COALESCE(pk.qty_in_base_uom, 1)::numeric,
    p.base_uom_id,
    (pk.id IS NULL),
    v_count
  FROM public.products p
  LEFT JOIN public.product_packaging pk ON pk.id = v_ident.packaging_id
  WHERE p.id = v_pid AND p.is_active = true;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_product_identity(uuid, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text, uuid) TO authenticated, service_role;

-- B′: server-side enrollment queue projection
CREATE OR REPLACE FUNCTION public.product_identification_queue(
  p_business_id uuid,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  product_id uuid, product_name text, sku text, unit_price numeric,
  image_url text, category_id uuid,
  packaging_id uuid, level_name text, qty_in_base_uom numeric,
  identifier_count integer, primary_code text, is_waived boolean,
  needs_identifier boolean, pending_product_count bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH gate AS (
    SELECT public.user_can_access_business(auth.uid(), p_business_id) AS ok
  ), prod AS (
    SELECT p.id, p.name::text AS nm, p.sku::text AS sk, p.unit_price,
           p.image_url::text AS img, p.category_id, p.created_at
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.is_active = true
       AND p.review_reason IS NULL
       AND (SELECT ok FROM gate)
       AND (
         p_search IS NULL OR btrim(p_search) = ''
         OR p.name ILIKE '%' || btrim(p_search) || '%'
         OR p.sku  ILIKE '%' || btrim(p_search) || '%'
       )
  ), levels AS (
    SELECT pr.id AS product_id, NULL::uuid AS packaging_id,
           'Base unit'::text AS level_name, 1::numeric AS qty
      FROM prod pr
    UNION ALL
    SELECT pk.product_id, pk.id, pk.name::text, pk.qty_in_base_uom
      FROM public.product_packaging pk
      JOIN prod pr ON pr.id = pk.product_id
     WHERE pk.business_id = p_business_id
  ), enriched AS (
    SELECT l.product_id, l.packaging_id, l.level_name, l.qty,
           COALESCE(i.cnt, 0)::int AS cnt,
           i.code,
           EXISTS (
             SELECT 1 FROM public.product_identification_waivers w
              WHERE w.business_id = p_business_id
                AND w.product_id = l.product_id
                AND w.packaging_id IS NOT DISTINCT FROM l.packaging_id
           ) AS waived
      FROM levels l
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS cnt,
               (array_agg(pi.code ORDER BY pi.is_primary DESC, pi.created_at))[1] AS code
          FROM public.product_identifiers pi
         WHERE pi.business_id = p_business_id
           AND pi.product_id = l.product_id
           AND pi.packaging_id IS NOT DISTINCT FROM l.packaging_id
           AND pi.kind IN ('gtin','pack','supplier','alias','plu','internal')
      ) i ON true
  ), pending AS (
    SELECT e.product_id
      FROM enriched e
     GROUP BY e.product_id
    HAVING bool_or(e.cnt = 0 AND NOT e.waived)
  ), page AS (
    SELECT pr.*
      FROM prod pr
      JOIN pending pd ON pd.product_id = pr.id
     ORDER BY pr.created_at ASC, pr.id
     LIMIT GREATEST(COALESCE(p_limit, 50), 0)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT pg.id, pg.nm, pg.sk, pg.unit_price, pg.img, pg.category_id,
         e.packaging_id, e.level_name, e.qty, e.cnt, e.code, e.waived,
         (e.cnt = 0 AND NOT e.waived),
         (SELECT count(*) FROM pending)
    FROM page pg
    JOIN enriched e ON e.product_id = pg.id
   ORDER BY pg.created_at, pg.id, e.qty;
$function$;

REVOKE ALL ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) TO authenticated, service_role;
