-- 1. Canonical GRN numbering: sequential, branch-scoped, prefix-aware.
DROP FUNCTION IF EXISTS public.get_next_grn_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_grn_number(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prefix text := 'GRN';
  v_year   text := to_char(CURRENT_DATE, 'YYYY');
  v_cfg    jsonb;
  v_next   integer;
BEGIN
  IF _business_id IS NOT NULL AND _branch_id IS NOT NULL THEN
    BEGIN
      v_cfg := public.get_effective_company_config(_business_id, _branch_id);
      v_prefix := COALESCE(NULLIF(v_cfg->'goods_receipt_prefix'->>'value', ''), 'GRN');
    EXCEPTION WHEN OTHERS THEN
      v_prefix := 'GRN';
    END;
  END IF;
  v_prefix := COALESCE(v_prefix, 'GRN');

  PERFORM pg_advisory_xact_lock(
    hashtext('goods_receipts_' || _org_id::text || '_' || COALESCE(_branch_id::text, 'global'))
  );

  SELECT COALESCE(MAX(
           CAST(substring(receipt_number FROM '([0-9]+)$') AS integer)
         ), 0) + 1
    INTO v_next
    FROM public.goods_receipts
   WHERE organization_id = _org_id
     AND (_branch_id IS NULL OR branch_id = _branch_id)
     AND receipt_number ~ ('^' || v_prefix || '-' || v_year || '-[0-9]+$');

  RETURN v_prefix || '-' || v_year || '-' || LPAD(v_next::text, 5, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_next_grn_number(uuid, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.get_next_grn_number(uuid, uuid, uuid)
  IS 'Canonical goods-receipt numbering. Sequential per organization/branch and year. Never derive a document number from a UUID fragment.';

-- 2. Point the two receipt writers at the numbering engine (surgical body patch).
DO $patch$
DECLARE
  r RECORD;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('create_goods_receipt', 'receive_inbound_shipment')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      '''GRN-''\s*\|\|\s*to_char\(now\(\),''YYYYMMDD''\)\s*\|\|\s*''-''\s*\|\|\s*substr\(gen_random_uuid\(\)::text,\s*1,\s*8\)',
      'public.get_next_grn_number(v_org_id, _business_id, v_branch_id)',
      'g'
    );
    IF v_new = v_def THEN
      RAISE EXCEPTION 'GRN numbering patch did not apply to %', r.proname;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$patch$;

-- 3. FX revaluation run references: sequential, not random.
DO $fx$
DECLARE
  r RECORD;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('revalue_fx_balances', 'reverse_fx_revaluation_run')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      '''FX-''\s*\|\|\s*to_char\(_run_date,\s*''YYYYMMDD''\)\s*\|\|\s*''-''\s*\|\|\s*upper\(substr\(gen_random_uuid\(\)::text,\s*1,\s*6\)\)',
      '''FXREV-'' || to_char(_run_date, ''YYYY'') || ''-'' || LPAD((( SELECT count(*) FROM public.fx_revaluation_runs f WHERE f.organization_id = _org_id AND date_part(''year'', f.run_date) = date_part(''year'', _run_date)) + 1)::text, 4, ''0'')',
      'g'
    );
    v_new := regexp_replace(
      v_new,
      '''FXR-''\s*\|\|\s*to_char\(_reversal_date,\s*''YYYYMMDD''\)\s*\|\|\s*''-''\s*\|\|\s*upper\(substr\(gen_random_uuid\(\)::text,\s*1,\s*6\)\)',
      '''FXREVR-'' || to_char(_reversal_date, ''YYYY'') || ''-'' || LPAD((( SELECT count(*) FROM public.fx_revaluation_runs f WHERE f.organization_id = _org_id AND f.reversal_of_run_id IS NOT NULL AND date_part(''year'', f.run_date) = date_part(''year'', _reversal_date)) + 1)::text, 4, ''0'')',
      'g'
    );
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END
$fx$;

-- 4. Renumber the existing UUID-suffixed receipts in chronological order.
WITH ordered AS (
  SELECT id,
         organization_id,
         branch_id,
         row_number() OVER (PARTITION BY organization_id, branch_id ORDER BY receipt_date, created_at) AS seq,
         to_char(COALESCE(receipt_date, created_at::date), 'YYYY') AS yr
    FROM public.goods_receipts
   WHERE receipt_number ~ '^GRN-[0-9]{8}-[0-9a-f]{8}$'
)
UPDATE public.goods_receipts g
   SET receipt_number = 'GRN-' || o.yr || '-' || LPAD(o.seq::text, 5, '0')
  FROM ordered o
 WHERE g.id = o.id;