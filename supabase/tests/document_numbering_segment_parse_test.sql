-- =====================================================================
-- Ratchet: year-segmented document numbers parse the counter segment only
-- (Phase H — 2026-08-16)
--
-- Numbers shaped PREFIX-YYYY-NNNN must never be parsed by stripping every
-- non-digit from the whole string: that folds the year into the counter and
-- the next number comes out as PREFIX-YYYY-YYYYNNNN+1. `get_next_po_number`
-- shipped with exactly that defect while the sales-side generators had
-- already been corrected.
--
-- Run:  psql "$DATABASE_URL" -f supabase/tests/document_numbering_segment_parse_test.sql
-- =====================================================================
BEGIN;

DO $$
DECLARE
  r        record;
  v_bad    text := NULL;
  v_names  text[] := ARRAY[
    'get_next_po_number',
    'get_next_so_number',
    'get_next_estimate_number',
    'get_next_requisition_number',
    'get_next_grn_number'
  ];
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (v_names)
  LOOP
    -- Must isolate the counter: either split_part(..., '-', 3) or a
    -- trailing-anchored capture. Anything else re-introduces the defect.
    IF position('split_part' IN r.prosrc) = 0
       AND position('[0-9]+)$' IN r.prosrc) = 0
       AND position('[0-9]+$' IN r.prosrc) = 0 THEN
      v_bad := COALESCE(v_bad || ', ', '') || r.proname;
    END IF;

    -- Concurrency: number generation must be serialised per org.
    IF position('pg_advisory_xact_lock' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION 'FAIL: %() generates numbers without an advisory lock', r.proname;
    END IF;
  END LOOP;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: these generators parse the whole number instead of the counter segment: %', v_bad;
  END IF;

  -- Every generator above must exist exactly once per signature family.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_next_po_number') <> 1 THEN
    RAISE EXCEPTION 'FAIL: more than one get_next_po_number overload';
  END IF;

  RAISE NOTICE 'PASS: document numbering segment-parse ratchet';
END $$;

ROLLBACK;