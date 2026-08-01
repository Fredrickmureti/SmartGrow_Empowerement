-- A' : harden product identification model

-- 1. Rebuild code_norm with the correct normalization (upper + trim)
ALTER TABLE public.product_identifiers DROP COLUMN IF EXISTS code_norm;

-- 2. Remove rows that would collide under the corrected normalization
DELETE FROM public.product_identifiers pi
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY business_id, upper(btrim(code))
           ORDER BY is_primary DESC, created_at ASC, id ASC
         ) AS rn
    FROM public.product_identifiers
) d
WHERE d.id = pi.id AND d.rn > 1;

ALTER TABLE public.product_identifiers
  ADD COLUMN code_norm text GENERATED ALWAYS AS (upper(btrim(code))) STORED;

CREATE UNIQUE INDEX product_identifiers_business_code_norm_key
  ON public.product_identifiers (business_id, code_norm);
CREATE UNIQUE INDEX product_identifiers_business_code_norm_kind_key
  ON public.product_identifiers (business_id, code_norm, kind);

-- 3. Tenant-gate the resolver
CREATE OR REPLACE FUNCTION public.resolve_product_identity(p_business_id uuid, p_code text)
 RETURNS TABLE(product_id uuid, product_name text, sku text, identifier_id uuid, matched_kind product_identifier_kind, matched_code text, packaging_id uuid, packaging_name text, qty_in_base_uom numeric, base_uom_id uuid, is_base_unit boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_ident record;
  v_pid uuid;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN;
  END IF;
  IF length(v_code) = 0 THEN RETURN; END IF;

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
   ORDER BY pi.is_primary DESC
   LIMIT 1;

  IF v_ident.product_id IS NULL THEN
    SELECT p.id INTO v_pid
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.is_active = true
       AND p.sku IS NOT NULL
       AND upper(btrim(p.sku)) = v_norm
     LIMIT 1;
    IF v_pid IS NULL THEN RETURN; END IF;
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
    (pk.id IS NULL)
  FROM public.products p
  LEFT JOIN public.product_packaging pk ON pk.id = v_ident.packaging_id
  WHERE p.id = v_pid AND p.is_active = true;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_product_identity(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text) TO authenticated, service_role;

-- 4. Tenant-gate the identification status projection
CREATE OR REPLACE FUNCTION public.product_identification_status(p_business_id uuid, p_product_ids uuid[])
 RETURNS TABLE(product_id uuid, packaging_id uuid, level_name text, qty_in_base_uom numeric, sort_qty numeric, identifier_count integer, primary_code text, is_waived boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH gate AS (
    SELECT public.user_can_access_business(auth.uid(), p_business_id) AS ok
  ), levels AS (
    SELECT p.id AS product_id, NULL::uuid AS packaging_id,
           'Base unit'::text AS level_name, 1::numeric AS qty_in_base_uom,
           1::numeric AS sort_qty
      FROM public.products p
     WHERE p.business_id = p_business_id
       AND p.id = ANY(p_product_ids)
       AND (SELECT ok FROM gate)
    UNION ALL
    SELECT pk.product_id, pk.id, pk.name::text, pk.qty_in_base_uom, pk.qty_in_base_uom
      FROM public.product_packaging pk
     WHERE pk.business_id = p_business_id
       AND pk.product_id = ANY(p_product_ids)
       AND (SELECT ok FROM gate)
  )
  SELECT
    l.product_id,
    l.packaging_id,
    l.level_name,
    l.qty_in_base_uom,
    l.sort_qty,
    COALESCE(i.cnt, 0)::int,
    i.code,
    EXISTS (
      SELECT 1 FROM public.product_identification_waivers w
       WHERE w.business_id = p_business_id
         AND w.product_id = l.product_id
         AND w.packaging_id IS NOT DISTINCT FROM l.packaging_id
    )
  FROM levels l
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS cnt,
           (array_agg(pi.code ORDER BY pi.is_primary DESC, pi.created_at))[1] AS code
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.product_id = l.product_id
       AND pi.packaging_id IS NOT DISTINCT FROM l.packaging_id
       AND pi.kind IN ('gtin','pack','supplier','alias','plu','internal')
  ) i ON true;
$function$;

REVOKE ALL ON FUNCTION public.product_identification_status(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.product_identification_status(uuid, uuid[]) TO authenticated, service_role;

-- 5. Business-scoped RLS on waivers
DROP POLICY IF EXISTS piw_select ON public.product_identification_waivers;
DROP POLICY IF EXISTS piw_insert ON public.product_identification_waivers;
DROP POLICY IF EXISTS piw_update ON public.product_identification_waivers;
DROP POLICY IF EXISTS piw_delete ON public.product_identification_waivers;

CREATE POLICY piw_select ON public.product_identification_waivers
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY piw_insert ON public.product_identification_waivers
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY piw_update ON public.product_identification_waivers
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));
CREATE POLICY piw_delete ON public.product_identification_waivers
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));
