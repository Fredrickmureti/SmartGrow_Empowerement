-- =====================================================================
-- Phase 1 — one shared document numbering authority
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_next_document_number(
  p_org uuid,
  p_business uuid,
  p_prefix text,
  p_table text,
  p_column text,
  p_business_column text DEFAULT 'business_id',
  p_width integer DEFAULT 4
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_year   text := to_char(now(), 'YYYY');
  v_next   int;
  v_num    text;
  v_taken  boolean;
  v_guard  int := 0;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'get_next_document_number: organization is required';
  END IF;
  IF p_prefix IS NULL OR p_prefix !~ '^[A-Z][A-Z]*$' THEN
    RAISE EXCEPTION 'get_next_document_number: prefix must be uppercase letters, got %', p_prefix;
  END IF;

  -- Serialise issuance per prefix + organization (+ business where the
  -- uniqueness constraint is narrower) for the whole transaction.
  PERFORM pg_advisory_xact_lock(
    hashtext('document_number:' || p_prefix || ':' || p_org::text
             || ':' || COALESCE(p_business::text, '-')));

  -- Parse ONLY the trailing counter segment. Stripping every non-digit from
  -- the whole string folds the year into the counter (PO-2026-20260004).
  EXECUTE format(
    'SELECT COALESCE(MAX((regexp_match(%1$I, %2$L))[1]::int), 0) + 1
       FROM public.%3$I
      WHERE organization_id = $1
        AND ($2 IS NULL OR %4$I = $2)
        AND %1$I ~ %5$L',
    p_column,
    '([0-9]+)$',
    p_table,
    p_business_column,
    '^' || p_prefix || '-' || v_year || '-[0-9]+$'
  )
  INTO v_next
  USING p_org, p_business;

  -- Collision guard: a stale max must never surface as a unique violation.
  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 1000 THEN
      RAISE EXCEPTION 'get_next_document_number: could not allocate a % number', p_prefix;
    END IF;

    v_num := p_prefix || '-' || v_year || '-' || LPAD(v_next::text, GREATEST(p_width, 1), '0');

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%1$I
                       WHERE organization_id = $1
                         AND ($2 IS NULL OR %2$I = $2)
                         AND %3$I = $3)',
      p_table, p_business_column, p_column
    )
    INTO v_taken
    USING p_org, p_business, v_num;

    EXIT WHEN NOT v_taken;
    v_next := v_next + 1;
  END LOOP;

  RETURN v_num;
END;
$function$;

COMMENT ON FUNCTION public.get_next_document_number(uuid, uuid, text, text, text, text, integer) IS
  'Single serialising authority for PREFIX-YYYY-NNNN document numbers. Advisory-locked per prefix+org(+business), parses the trailing counter segment only, retries on collision.';

REVOKE ALL ON FUNCTION public.get_next_document_number(uuid, uuid, text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_next_document_number(uuid, uuid, text, text, text, text, integer) TO authenticated, service_role;

-- =====================================================================
-- Phase 2 — per-document issuers for warehouse operations
-- =====================================================================
CREATE OR REPLACE FUNCTION public.get_next_wave_number(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'WAVE', 'wms_pick_waves', 'wave_number');
$function$;

CREATE OR REPLACE FUNCTION public.get_next_asn_number(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'ASN', 'inbound_shipments', 'shipment_number');
$function$;

CREATE OR REPLACE FUNCTION public.get_next_manifest_number(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'LM', 'wms_loading_manifests', 'code');
$function$;

CREATE OR REPLACE FUNCTION public.get_next_carton_number(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'SHIP', 'wms_license_plates', 'code');
$function$;

CREATE OR REPLACE FUNCTION public.get_next_recall_reference(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'RCL', 'product_recalls', 'recall_reference');
$function$;

CREATE OR REPLACE FUNCTION public.get_next_opening_stock_number(p_org uuid, p_business uuid DEFAULT NULL)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.get_next_document_number(p_org, p_business, 'OPEN', 'stock_adjustments', 'adjustment_number');
$function$;

DO $grants$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_next_wave_number','get_next_asn_number','get_next_manifest_number',
                         'get_next_carton_number','get_next_recall_reference','get_next_opening_stock_number')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END
$grants$;

-- =====================================================================
-- Retrofit the callers. Each replacement is asserted: if the source text
-- has drifted the migration fails loudly rather than silently no-op.
-- =====================================================================
DO $retrofit$
DECLARE
  v_specs jsonb := jsonb_build_array(
    jsonb_build_object(
      'fn', 'create_pick_wave',
      'pattern', '''WAVE-'' \|\| to_char\(now\(\), ''YYMMDD''\) \|\| ''-'' \|\| upper\(substr\(md5\(gen_random_uuid\(\)::text\), 1, 5\)\)',
      'repl', 'public.get_next_wave_number(v_wh.organization_id, v_wh.business_id)'),
    jsonb_build_object(
      'fn', 'wms_plan_waves',
      'pattern', '''WAVE-''[^;]*upper\(substr\(md5\(gen_random_uuid\(\)::text\), 1, 5\)\)',
      'repl', 'public.get_next_wave_number(v_wh.organization_id, v_wh.business_id)'),
    jsonb_build_object(
      'fn', 'wms_enqueue_order_for_wave',
      'pattern', '''WAVE-''[^;]*upper\(substr\(md5\(gen_random_uuid\(\)::text\), 1, 5\)\)',
      'repl', 'public.get_next_wave_number(v_policy.organization_id, v_policy.business_id)'),
    jsonb_build_object(
      'fn', 'create_inbound_shipment',
      'pattern', '''ASN-'' \|\| to_char\(now\(\),''YYYYMMDD''\) \|\| ''-'' \|\| substr\(v_id::text,1,8\)',
      'repl', 'public.get_next_asn_number(v_org, p_business_id)'),
    jsonb_build_object(
      'fn', 'open_loading_manifest',
      'pattern', '''LM-'' \|\| to_char\(now\(\),''YYMMDD-HH24MISS''\)',
      'repl', 'public.get_next_manifest_number(v_dock.organization_id, v_dock.business_id)'),
    jsonb_build_object(
      'fn', 'open_pack_carton',
      'pattern', '''SHIP-''[^;]*substr\(replace\(gen_random_uuid\(\)::text, ''-'', ''''\), 1, 6\)',
      'repl', 'public.get_next_carton_number(v_wave.organization_id, v_wave.business_id)'),
    jsonb_build_object(
      'fn', 'recall_lot',
      'pattern', '''RCL-''[^;]*substr\(replace\(v_lot\.id::text, ''-'', ''''\), 1, 6\)',
      'repl', 'public.get_next_recall_reference(v_org_id, p_business_id)'),
    jsonb_build_object(
      'fn', 'record_opening_stock',
      'pattern', '''OPEN-'' \|\| to_char\(now\(\), ''YYYYMMDD-HH24MISS''\)',
      'repl', 'public.get_next_opening_stock_number(v_org_id, p_business_id)'),
    jsonb_build_object(
      'fn', 'wms_create_return_finance_doc',
      'pattern', '''SR-'' \|\| to_char\(now\(\), ''YYYYMM''\) \|\| ''-'' \|\| upper\(substr\(replace\(v_ord\.id::text, ''-'', ''''\), 1, 6\)\)',
      'repl', 'public.get_next_sales_return_number(v_ord.organization_id, v_ord.business_id, v_branch)'),
    jsonb_build_object(
      'fn', 'wms_create_return_finance_doc',
      'pattern', '''PR-'' \|\| to_char\(now\(\), ''YYYYMM''\) \|\| ''-'' \|\| upper\(substr\(replace\(v_ord\.id::text, ''-'', ''''\), 1, 6\)\)',
      'repl', 'public.get_next_purchase_return_number(v_ord.organization_id, v_ord.business_id)'),
    jsonb_build_object(
      'fn', 'convert_lead_to_estimate',
      'pattern', 'COALESCE\(v_new_no, ''EST-'' \|\| extract\(epoch from now\(\)\)::bigint::text\)',
      'repl', 'v_new_no'),
    jsonb_build_object(
      'fn', 'convert_lead_to_project',
      'pattern', 'COALESCE\(v_new_no, ''PROJ-'' \|\| extract\(epoch from now\(\)\)::bigint::text\)',
      'repl', 'v_new_no'),
    jsonb_build_object(
      'fn', 'request_employee_loan',
      'pattern', 'v_loan_number := ''LR-'' \|\| to_char\(now\(\),''YYYYMMDDHH24MISS''\);',
      'repl', 'RAISE EXCEPTION ''Loan numbering is unavailable; get_next_loan_number is missing.'' USING ERRCODE=''0A000'';')
  );
  v_spec  jsonb;
  v_oid   oid;
  v_def   text;
  v_new   text;
BEGIN
  FOR v_spec IN SELECT * FROM jsonb_array_elements(v_specs)
  LOOP
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = (v_spec->>'fn')
     LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'numbering retrofit: function %() not found', v_spec->>'fn';
    END IF;

    v_def := pg_get_functiondef(v_oid);
    v_new := regexp_replace(v_def, v_spec->>'pattern', v_spec->>'repl', 'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION 'numbering retrofit: pattern did not match in %()', v_spec->>'fn';
    END IF;

    EXECUTE v_new;
  END LOOP;
END
$retrofit$;
