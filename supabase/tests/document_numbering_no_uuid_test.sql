-- Ratchet: user-facing document numbers must never embed a UUID fragment.
-- A document number is a business reference (GRN-2026-00001), issued by a
-- numbering function under an advisory lock — not a random database artefact.
DO $$
DECLARE
  v_bad text;
BEGIN
  -- 1. No live function may mint a number from gen_random_uuid().
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND pg_get_functiondef(p.oid) ~ '''[A-Z]{2,8}-''\s*\|\|[^;]*gen_random_uuid\(\)::text';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Document numbers built from a UUID fragment in: %', v_bad;
  END IF;

  -- 2. The goods-receipt writers must delegate to the numbering engine.
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_goods_receipt', 'receive_inbound_shipment')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%get_next_grn_number%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Goods receipt writers not using get_next_grn_number: %', v_bad;
  END IF;

  -- 3. The numbering engine must serialise concurrent issuance.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_next_grn_number')
     NOT ILIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'get_next_grn_number lost its advisory lock';
  END IF;

  -- 4. No stored receipt number may look like a UUID fragment.
  SELECT string_agg(receipt_number, ', ')
    INTO v_bad
    FROM public.goods_receipts
   WHERE receipt_number ~ '[0-9a-f]{8}$'
     AND receipt_number !~ '^[A-Z]+-[0-9]{4}-[0-9]+$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Goods receipts carrying UUID-shaped numbers: %', v_bad;
  END IF;

  RAISE NOTICE 'document_numbering_no_uuid_test: PASS';
END
$$;
