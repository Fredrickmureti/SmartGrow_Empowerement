-- Ratchet: GL cross-references (journal_entries.reference and the approval
-- labels that quote a document) must be human-readable business references
-- (BDEP-2026-0001, OB-BANK-2026-0001, EXP-2026-0007) — never a UUID slice.
-- Regression: `BDEP-7534e575` / `OB-BANK-cf817a72`, fixed 2026-08-19.
DO $$
DECLARE
  v_bad text;
  v_def text;
BEGIN
  -- 1. No live function may build a prefixed reference from a UUID fragment.
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND pg_get_functiondef(p.oid) ~*
         '''[A-Z][A-Z-]{1,12}-''\s*\|\|\s*(left|substr|substring)\s*\(\s*[a-z_.]*(id|_id)[a-z_.]*::text'
     -- Machine-only barcodes may stay opaque by design.
     AND p.proname NOT IN ('generate_lpn', 'wms_generate_lpn');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'GL references built from a UUID slice in: %', v_bad;
  END IF;

  -- 2. The reference issuers converted on 2026-08-19 must delegate to the
  --    shared numbering authority.
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('bank_match_confirm', '_bank_account_post_opening_balance',
                       'disburse_employee_advance', 'record_vendor_advance_payment')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%get_next_document_number%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Reference issuers not using get_next_document_number: %', v_bad;
  END IF;

  -- 3. The authority accepts hyphenated prefixes (OB-BANK) and still rejects junk.
  v_def := (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'get_next_document_number');
  IF v_def NOT ILIKE '%^[A-Z]+(-[A-Z]+)*$%' THEN
    RAISE EXCEPTION 'get_next_document_number no longer allows hyphenated prefixes';
  END IF;
  IF v_def NOT ILIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'get_next_document_number lost its advisory lock';
  END IF;
  IF 'OB-BANK' !~ '^[A-Z]+(-[A-Z]+)*$' OR 'ob-bank' ~ '^[A-Z]+(-[A-Z]+)*$'
     OR 'OB--BANK' ~ '^[A-Z]+(-[A-Z]+)*$' THEN
    RAISE EXCEPTION 'prefix grammar does not behave as intended';
  END IF;

  -- 4. No newly issued journal reference may be a UUID slice. Historical rows
  --    are immutable, so only entries created after the fix are checked.
  SELECT string_agg(reference, ', ')
    INTO v_bad
    FROM public.journal_entries
   WHERE created_at > '2026-08-19 17:00:00+00'::timestamptz
     AND reference ~ '-[0-9a-f]{8}$'
     AND reference !~ '^[A-Z][A-Z-]*-[0-9]{4}-[0-9]+$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entries carrying UUID-shaped references: %', v_bad;
  END IF;

  RAISE NOTICE 'gl_reference_no_uuid_slice_test: PASS';
END
$$;
