-- ADR-0110 Phase 6 — ONE GS1 grammar, ONE candidate generator, ONE matcher.

-- 1. GS1 Application Identifier table (mirror of src/lib/gs1/aiTable.ts).
CREATE OR REPLACE FUNCTION public.gs1_ai_table()
RETURNS TABLE(ai text, name text, fixed int, max_len int, decimal_indicator boolean)
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT * FROM (VALUES
    ('00','sscc',18,NULL,false),
    ('01','gtin',14,NULL,false),
    ('02','gtinContained',14,NULL,false),
    ('10','lot',NULL,20,false),
    ('11','productionDate',6,NULL,false),
    ('13','packagingDate',6,NULL,false),
    ('15','bestBefore',6,NULL,false),
    ('17','expiry',6,NULL,false),
    ('20','variant',2,NULL,false),
    ('21','serial',NULL,20,false),
    ('30','count',NULL,8,false),
    ('37','countOfUnits',NULL,8,false),
    ('240','additionalItemId',NULL,30,false),
    ('241','customerPart',NULL,30,false),
    ('310','netWeightKg',6,NULL,true),
    ('311','lengthM',6,NULL,true),
    ('312','widthM',6,NULL,true),
    ('313','depthM',6,NULL,true),
    ('314','areaM2',6,NULL,true),
    ('315','netVolumeL',6,NULL,true),
    ('316','netVolumeM3',6,NULL,true)
  ) t(ai, name, fixed, max_len, decimal_indicator);
$$;

GRANT EXECUTE ON FUNCTION public.gs1_ai_table() TO authenticated, service_role;

-- 2. Table-driven GS1 element-string parser. Returns jsonb of AI name → value
--    (plus `_ai_<ai>` raw echoes). NULL when the payload is not GS1.
CREATE OR REPLACE FUNCTION public.parse_gs1_element_string(p_raw text)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  FNC1 constant text := chr(29);
  v_in text := coalesce(p_raw, '');
  v_cursor int := 1;
  v_out jsonb := '{}'::jsonb;
  v_spec record;
  v_prefix_len int;
  v_value text;
  v_end int;
  v_stop int;
  v_decimals int;
BEGIN
  -- Strip scanner symbology identifiers and a leading FNC1.
  FOREACH v_value IN ARRAY ARRAY[']C1', ']e0', ']d2', ']Q3'] LOOP
    IF left(v_in, 3) = v_value THEN v_in := substring(v_in FROM 4); END IF;
  END LOOP;
  IF left(v_in, 1) = FNC1 THEN v_in := substring(v_in FROM 2); END IF;
  -- Human-readable bracket form: (01)05012345678900(10)LOT42
  IF v_in ~ '^\(\d{2,4}\)' THEN
    v_in := replace(replace(v_in, '(', ''), ')', '');
  END IF;
  v_in := upper(btrim(v_in));

  IF length(v_in) < 4 THEN RETURN NULL; END IF;

  WHILE v_cursor <= length(v_in) LOOP
    v_spec := NULL;
    v_decimals := NULL;

    -- Try 4-digit decimal-indicator AIs (310n..316n), then 3-, then 2-digit.
    SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
     WHERE t.decimal_indicator
       AND t.ai = substring(v_in FROM v_cursor FOR 3)
       AND substring(v_in FROM v_cursor + 3 FOR 1) ~ '^[0-9]$'
     LIMIT 1;
    IF v_spec.ai IS NOT NULL THEN
      v_prefix_len := 4;
      v_decimals := substring(v_in FROM v_cursor + 3 FOR 1)::int;
    ELSE
      SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
       WHERE NOT t.decimal_indicator AND t.ai = substring(v_in FROM v_cursor FOR 3) LIMIT 1;
      IF v_spec.ai IS NOT NULL THEN
        v_prefix_len := 3;
      ELSE
        SELECT t.* INTO v_spec FROM public.gs1_ai_table() t
         WHERE NOT t.decimal_indicator AND t.ai = substring(v_in FROM v_cursor FOR 2) LIMIT 1;
        v_prefix_len := 2;
      END IF;
    END IF;

    IF v_spec.ai IS NULL THEN
      -- Not an AI here: soft-fail with what we have (mirrors parseGs1).
      IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
      EXIT;
    END IF;

    v_cursor := v_cursor + v_prefix_len;

    IF v_spec.fixed IS NOT NULL THEN
      v_value := substring(v_in FROM v_cursor FOR v_spec.fixed);
      IF length(v_value) < v_spec.fixed THEN
        IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
        EXIT;
      END IF;
      v_cursor := v_cursor + v_spec.fixed;
    ELSE
      v_end := position(FNC1 IN substring(v_in FROM v_cursor));
      IF v_end = 0 THEN
        v_stop := least(length(v_in) + 1, v_cursor + coalesce(v_spec.max_len, 48));
        v_value := substring(v_in FROM v_cursor FOR v_stop - v_cursor);
        v_cursor := v_stop;
      ELSE
        v_value := substring(v_in FROM v_cursor FOR v_end - 1);
        v_cursor := v_cursor + v_end;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_object(v_spec.name, v_value);
    IF v_decimals IS NOT NULL THEN
      v_out := v_out || jsonb_build_object(
        '_' || v_spec.name, (v_value::numeric / power(10, v_decimals)));
    END IF;
  END LOOP;

  IF v_out = '{}'::jsonb THEN RETURN NULL; END IF;
  RETURN v_out;
END $$;

GRANT EXECUTE ON FUNCTION public.parse_gs1_element_string(text) TO authenticated, service_role;

-- 3. ONE candidate generator. Mirror of src/lib/gs1/identityCodes.ts.
CREATE OR REPLACE FUNCTION public.identity_code_candidates(p_raw text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_norm text := upper(btrim(coalesce(p_raw, '')));
  v_out text[] := ARRAY[]::text[];
  v_gs1 jsonb;
  v_gtin text;
  v_digits text;
  v_stripped text;
  v_w int;
BEGIN
  IF length(v_norm) = 0 THEN RETURN v_out; END IF;
  v_out := ARRAY[v_norm];

  -- (2) GS1 element string → its AI (01) GTIN.
  v_gs1 := public.parse_gs1_element_string(p_raw);
  v_gtin := v_gs1->>'gtin';
  IF v_gtin IS NOT NULL AND NOT (v_gtin = ANY(v_out)) THEN
    v_out := v_out || v_gtin;
  END IF;

  -- (3) GTIN-8/12/13/14 padding family, for the raw code and for the GTIN.
  FOREACH v_digits IN ARRAY ARRAY[v_norm, coalesce(v_gtin, '')] LOOP
    CONTINUE WHEN v_digits !~ '^[0-9]{8,14}$';
    v_stripped := coalesce(nullif(ltrim(v_digits, '0'), ''), '0');
    IF NOT (v_stripped = ANY(v_out)) THEN v_out := v_out || v_stripped; END IF;
    FOREACH v_w IN ARRAY ARRAY[8, 12, 13, 14] LOOP
      CONTINUE WHEN length(v_stripped) > v_w;
      IF NOT (lpad(v_stripped, v_w, '0') = ANY(v_out)) THEN
        v_out := v_out || lpad(v_stripped, v_w, '0');
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_out;
END $$;

GRANT EXECUTE ON FUNCTION public.identity_code_candidates(text) TO anon, authenticated, service_role;

-- 4. The authoritative resolver now uses the shared grammar, and counts
--    DISTINCT PRODUCTS for ambiguity (two codes on one product is not
--    ambiguous).
CREATE OR REPLACE FUNCTION public.resolve_product_identity(
  p_business_id uuid,
  p_code text,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_allow_sku_fallback boolean DEFAULT false)
RETURNS TABLE(status text, product_id uuid, product_name text, sku text, identifier_id uuid,
  matched_kind product_identifier_kind, matched_code text, packaging_id uuid, packaging_name text,
  qty_in_base_uom numeric, base_uom_id uuid, is_base_unit boolean, match_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text := btrim(coalesce(p_code, ''));
  v_norm text := upper(v_code);
  v_cands text[];
  v_ident record;
  v_pid uuid;
  v_count int := 0;
  v_status text;
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.user_can_access_business(v_user, p_business_id) THEN
    RETURN QUERY SELECT 'unauthorized'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
    RETURN;
  END IF;

  v_cands := public.identity_code_candidates(v_code);

  IF array_length(v_cands, 1) IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
    RETURN;
  END IF;

  -- Ambiguity = more than one DISTINCT product behind the live candidates.
  SELECT count(DISTINCT pi.product_id) INTO v_count
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now());

  SELECT pi.id, pi.product_id, pi.kind, pi.code, pi.packaging_id
    INTO v_ident
    FROM public.product_identifiers pi
   WHERE pi.business_id = p_business_id
     AND pi.code_norm = ANY(v_cands)
     AND pi.status = 'active'
     AND (pi.valid_from IS NULL OR pi.valid_from <= now())
     AND (pi.valid_to IS NULL OR pi.valid_to > now())
   ORDER BY (pi.code_norm = v_norm) DESC,
            array_position(v_cands, pi.code_norm),
            pi.is_primary DESC, pi.created_at
   LIMIT 1;

  IF v_ident.product_id IS NOT NULL THEN
    v_pid := v_ident.product_id;
    v_status := CASE WHEN v_count > 1 THEN 'ambiguous' ELSE 'resolved' END;
  ELSE
    SELECT CASE
             WHEN pi.status = 'archived' THEN 'archived'
             WHEN pi.status = 'inactive' THEN 'inactive'
             ELSE 'expired'
           END
      INTO v_status
      FROM public.product_identifiers pi
     WHERE pi.business_id = p_business_id
       AND pi.code_norm = ANY(v_cands)
     ORDER BY pi.updated_at DESC
     LIMIT 1;

    IF v_status IS NULL AND p_allow_sku_fallback THEN
      SELECT p.id INTO v_pid
        FROM public.products p
       WHERE p.business_id = p_business_id
         AND p.is_active = true
         AND p.sku IS NOT NULL
         AND upper(btrim(p.sku)) = ANY(v_cands)
       LIMIT 1;
      IF v_pid IS NOT NULL THEN
        v_status := 'resolved';
        v_count := 1;
      END IF;
    END IF;

    IF v_pid IS NULL AND v_status IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.product_identifiers pi
         WHERE pi.code_norm = ANY(v_cands) AND pi.business_id <> p_business_id
      ) THEN
        v_status := 'foreign_tenant';
      ELSE
        v_status := 'not_found';
      END IF;
    END IF;
  END IF;

  IF v_pid IS NULL THEN
    RETURN QUERY SELECT v_status, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, coalesce(v_count, 0);
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_status,
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
    GREATEST(v_count, 1)
  FROM public.products p
  LEFT JOIN public.product_packaging pk ON pk.id = v_ident.packaging_id
  WHERE p.id = v_pid AND p.is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid,
      NULL::public.product_identifier_kind, v_code, NULL::uuid, NULL::text,
      NULL::numeric, NULL::uuid, NULL::boolean, 0;
  END IF;
END $function$;

-- 5. Retire the legacy resolvers. No client surface calls them any more
--    (POS uses pos_resolve_scan; every other surface uses
--    resolve_product_identity). resolve_barcode_v2 was additionally broken.
DROP FUNCTION IF EXISTS public.resolve_barcode_v2(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.resolve_barcode_v2(uuid, text);
DROP FUNCTION IF EXISTS public.pos_resolve_barcode(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.pos_resolve_barcode(uuid, text);
