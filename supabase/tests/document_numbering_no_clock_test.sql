-- =====================================================================
-- Ratchet: operator-facing documents must not mint clock/hash identifiers
-- (Warehouse numbering remediation — 2026-08-17)
--
-- A document number is a business reference issued by a serialising
-- numbering function (WAVE-2026-0001), not a timestamp string
-- (CC-260817-013059278) or a truncated uuid/md5 fragment.
--
-- Run: psql "$DATABASE_URL" -f supabase/tests/document_numbering_no_clock_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  r       record;
  v_bad   text := NULL;
  v_defn  text;
  v_specs text[][] := ARRAY[
    ARRAY['create_pick_wave',              'get_next_wave_number'],
    ARRAY['wms_plan_waves',                'get_next_wave_number'],
    ARRAY['wms_enqueue_order_for_wave',    'get_next_wave_number'],
    ARRAY['create_inbound_shipment',       'get_next_asn_number'],
    ARRAY['open_loading_manifest',         'get_next_manifest_number'],
    ARRAY['open_pack_carton',              'get_next_carton_number'],
    ARRAY['recall_lot',                    'get_next_recall_reference'],
    ARRAY['record_opening_stock',          'get_next_opening_stock_number'],
    ARRAY['create_count_session_as',       'get_next_count_session_number']
  ];
  i int;
BEGIN
  -- 1. Each writer must delegate to its numbering authority.
  FOR i IN 1 .. array_length(v_specs, 1) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_defn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_specs[i][1]
     LIMIT 1;

    IF v_defn IS NULL THEN
      RAISE EXCEPTION 'FAIL: %() is missing', v_specs[i][1];
    END IF;
    IF position(v_specs[i][2] IN v_defn) = 0 THEN
      RAISE EXCEPTION 'FAIL: %() does not issue its number through %()',
        v_specs[i][1], v_specs[i][2];
    END IF;
  END LOOP;

  -- 2. No live function may build a document identifier from the clock.
  SELECT string_agg(DISTINCT p.proname, ', ')
    INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (ARRAY(SELECT v_specs[i][1]
                                  FROM generate_subscripts(v_specs, 1) AS i))
     AND pg_get_functiondef(p.oid) ~ '''[A-Z][A-Z-]*-''\s*\|\|\s*to_char\(\s*(now|clock_timestamp)\(\)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: clock-derived document identifiers in: %', v_bad;
  END IF;

  -- 3. The shared authority must serialise issuance and parse the counter
  --    segment only.
  SELECT pg_get_functiondef(p.oid) INTO v_defn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_next_document_number'
   LIMIT 1;
  IF v_defn IS NULL THEN
    RAISE EXCEPTION 'FAIL: get_next_document_number is missing';
  END IF;
  IF position('pg_advisory_xact_lock' IN v_defn) = 0 THEN
    RAISE EXCEPTION 'FAIL: get_next_document_number lost its advisory lock';
  END IF;
  IF position('[0-9]+)$' IN v_defn) = 0 THEN
    RAISE EXCEPTION 'FAIL: get_next_document_number no longer parses the trailing counter segment';
  END IF;

  -- 4. Numbers already issued by the new authority must be well formed.
  FOR r IN
    SELECT 'wms_pick_waves' AS t, wave_number AS num FROM public.wms_pick_waves
     WHERE wave_number LIKE 'WAVE-2%-%'
    UNION ALL
    SELECT 'wms_count_sessions', code FROM public.wms_count_sessions
     WHERE code LIKE 'CC-2%-%'
  LOOP
    IF r.num !~ '^[A-Z]+-[0-9][0-9][0-9][0-9]-[0-9]+$' THEN
      RAISE EXCEPTION 'FAIL: malformed number % on %', r.num, r.t;
    END IF;
  END LOOP;

  RAISE NOTICE 'PASS: document numbering clock/hash ratchet';
END $$;

ROLLBACK;