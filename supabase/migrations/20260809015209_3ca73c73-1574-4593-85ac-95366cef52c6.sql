-- A. Make the per-product identifier index status-aware.
-- Guard: refuse the migration if live duplicates exist.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT product_id, kind, code_norm
      FROM public.product_identifiers
     WHERE status = 'active'
     GROUP BY 1,2,3 HAVING count(*) > 1
  ) t;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Cannot narrow product_identifiers_product_kind_code_uidx: % active duplicate group(s) exist', v_bad;
  END IF;
END $$;

DROP INDEX IF EXISTS public.product_identifiers_product_kind_code_uidx;
CREATE UNIQUE INDEX product_identifiers_product_kind_code_uidx
  ON public.product_identifiers (product_id, kind, code_norm)
  WHERE status = 'active';

-- B. Correct upsert semantics: revive archived rows, never leak a raw
-- unique_violation (which PostgREST surfaces as an unexplained 409).
CREATE OR REPLACE FUNCTION public.upsert_product_identifier(
  p_business_id uuid,
  p_product_id uuid,
  p_code text DEFAULT NULL::text,
  p_kind product_identifier_kind DEFAULT 'gtin'::product_identifier_kind,
  p_packaging_id uuid DEFAULT NULL::uuid,
  p_is_primary boolean DEFAULT false,
  p_supplier_id uuid DEFAULT NULL::uuid,
  p_source product_identifier_source DEFAULT NULL::product_identifier_source,
  p_identifier_id uuid DEFAULT NULL::uuid,
  p_valid_from timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_valid_to timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_org uuid;
  v_clash record;
  v_id uuid;
  v_revived boolean := false;
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unauthenticated');
  END IF;
  IF length(v_code) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'empty_code');
  END IF;

  SELECT p.organization_id INTO v_org
    FROM public.products p
   WHERE p.id = p_product_id AND p.business_id = p_business_id;
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'unknown_product');
  END IF;

  IF p_packaging_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_packaging pk
     WHERE pk.id = p_packaging_id AND pk.product_id = p_product_id
       AND pk.business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'foreign_packaging_level');
  END IF;

  IF p_kind = 'supplier' AND p_supplier_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'reason', 'supplier_required');
  END IF;

  -- Live clash inside the business (the authoritative uniqueness scope).
  SELECT pi.id, pi.product_id, pi.packaging_id, pr.name AS product_name
    INTO v_clash
    FROM public.product_identifiers pi
    JOIN public.products pr ON pr.id = pi.product_id
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = v_norm
     AND pi.status = 'active'
     AND ((p_supplier_id IS NULL AND pi.supplier_id IS NULL)
       OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
     AND (p_identifier_id IS NULL OR pi.id <> p_identifier_id)
   LIMIT 1;

  IF v_clash.id IS NOT NULL THEN
    IF v_clash.product_id = p_product_id
       AND v_clash.packaging_id IS NOT DISTINCT FROM p_packaging_id THEN
      RETURN jsonb_build_object(
        'status', 'ok',
        'identifier_id', v_clash.id,
        'code', v_code,
        'idempotent', true
      );
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'reason', 'code_taken',
      'identifier_id', v_clash.id,
      'product_id', v_clash.product_id,
      'product_name', v_clash.product_name,
      'same_product', v_clash.product_id = p_product_id
    );
  END IF;

  BEGIN
    IF p_identifier_id IS NOT NULL THEN
      -- `source` is NOT NULL: an omitted capture source must keep the stored
      -- one, never blank it. Same for valid_from.
      UPDATE public.product_identifiers
         SET code = v_code,
             kind = p_kind,
             packaging_id = p_packaging_id,
             supplier_id = p_supplier_id,
             source = COALESCE(p_source, source, 'manual'::product_identifier_source),
             valid_from = COALESCE(p_valid_from, valid_from),
             valid_to = p_valid_to,
             status = 'active',
             updated_at = now()
       WHERE id = p_identifier_id
         AND business_id = p_business_id
         AND product_id = p_product_id
       RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid', 'reason', 'unknown_identifier');
      END IF;
    ELSE
      -- Revive a retired row for the same product/kind/code rather than
      -- opening a second lineage for the same physical code.
      UPDATE public.product_identifiers
         SET status = 'active',
             code = v_code,
             packaging_id = p_packaging_id,
             supplier_id = p_supplier_id,
             source = COALESCE(p_source, source, 'manual'::product_identifier_source),
             valid_from = COALESCE(p_valid_from, valid_from),
             valid_to = p_valid_to,
             replaced_by_id = NULL,
             updated_at = now()
       WHERE business_id = p_business_id
         AND product_id = p_product_id
         AND kind = p_kind
         AND code_norm = v_norm
         AND status <> 'active'
         AND id = (
           SELECT id FROM public.product_identifiers
            WHERE business_id = p_business_id
              AND product_id = p_product_id
              AND kind = p_kind
              AND code_norm = v_norm
              AND status <> 'active'
            ORDER BY updated_at DESC
            LIMIT 1
         )
       RETURNING id INTO v_id;

      IF v_id IS NOT NULL THEN
        v_revived := true;
      ELSE
        INSERT INTO public.product_identifiers
          (organization_id, business_id, product_id, code, kind, packaging_id,
           supplier_id, source, valid_from, valid_to, created_by, is_primary)
        VALUES
          (v_org, p_business_id, p_product_id, v_code, p_kind, p_packaging_id,
           p_supplier_id, COALESCE(p_source, 'manual'::product_identifier_source),
           p_valid_from, p_valid_to, v_user, false)
        RETURNING id INTO v_id;
      END IF;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent writer won the race. Report the domain outcome, never a
    -- raw 23505 (PostgREST would turn that into an opaque HTTP 409).
    SELECT pi.id, pi.product_id, pr.name AS product_name
      INTO v_clash
      FROM public.product_identifiers pi
      JOIN public.products pr ON pr.id = pi.product_id
     WHERE pi.business_id = p_business_id
       AND pi.code_norm = v_norm
       AND pi.status = 'active'
       AND ((p_supplier_id IS NULL AND pi.supplier_id IS NULL)
         OR (p_supplier_id IS NOT NULL AND pi.supplier_id = p_supplier_id))
     LIMIT 1;
    IF v_clash.id IS NOT NULL AND v_clash.product_id = p_product_id THEN
      RETURN jsonb_build_object(
        'status', 'ok', 'identifier_id', v_clash.id, 'code', v_code, 'idempotent', true
      );
    END IF;
    RETURN jsonb_build_object(
      'status', 'duplicate',
      'reason', 'code_taken',
      'identifier_id', v_clash.id,
      'product_id', v_clash.product_id,
      'product_name', v_clash.product_name,
      'same_product', false
    );
  END;

  IF p_is_primary AND p_supplier_id IS NULL THEN
    UPDATE public.product_identifiers
       SET is_primary = false, updated_at = now()
     WHERE product_id = p_product_id AND is_primary = true AND id <> v_id;
    UPDATE public.product_identifiers
       SET is_primary = true, updated_at = now()
     WHERE id = v_id;
  ELSIF p_supplier_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_identifiers
     WHERE product_id = p_product_id AND is_primary = true AND status = 'active'
  ) THEN
    UPDATE public.product_identifiers SET is_primary = true, updated_at = now() WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok', 'identifier_id', v_id, 'code', v_code, 'revived', v_revived
  );
END
$function$;