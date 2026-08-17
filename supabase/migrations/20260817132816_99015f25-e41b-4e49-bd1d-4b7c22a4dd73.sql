DO $fix$
DECLARE
  v_oid oid;
  v_def text;
  v_new text;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'convert_lead_to_estimate'
   LIMIT 1;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'convert_lead_to_estimate not found';
  END IF;

  v_def := pg_get_functiondef(v_oid);
  v_new := replace(
    v_def,
    'public.get_next_estimate_number(v_lead.organization_id)',
    'public.get_next_estimate_number(v_lead.organization_id, v_lead.business_id, v_branch_id)');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'convert_lead_to_estimate: estimate numbering call not found';
  END IF;

  EXECUTE v_new;
END
$fix$;

-- Smoke check: every new issuer must return PREFIX-YYYY-NNNN.
DO $smoke$
DECLARE
  v_org uuid;
  v_val text;
  r     record;
BEGIN
  SELECT id INTO v_org FROM public.organizations LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'no organizations: skipping numbering smoke check';
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('get_next_wave_number','WAVE'),
      ('get_next_asn_number','ASN'),
      ('get_next_manifest_number','LM'),
      ('get_next_carton_number','SHIP'),
      ('get_next_recall_reference','RCL'),
      ('get_next_opening_stock_number','OPEN')
    ) AS t(fn, prefix)
  LOOP
    EXECUTE format('SELECT public.%I($1, NULL)', r.fn) INTO v_val USING v_org;
    IF v_val !~ ('^' || r.prefix || '-' || to_char(now(),'YYYY') || '-[0-9][0-9][0-9][0-9]$') THEN
      RAISE EXCEPTION '% returned a non-conforming number: %', r.fn, v_val;
    END IF;
    RAISE NOTICE '% -> %', r.fn, v_val;
  END LOOP;
END
$smoke$;
