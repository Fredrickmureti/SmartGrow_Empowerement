-- ============================================================================
-- Landed Cost — bill encumbrance guard (Phase B, final item)
--
-- A supplier bill whose charges have been capitalised into inventory through a
-- landed cost voucher cannot be credited: the vendor credit note would credit
-- the same Landed Cost Clearing account the bill debited while the capitalised
-- charge stays inside the stock value, so the clearing account is relieved
-- twice and inventory is permanently overstated.
--
-- Read-only introspection plus live-data invariants, in the style of the other
-- landed cost ratchets. Run inside a transaction and roll back.
-- ============================================================================
BEGIN;

-- 1. one authority per question, one overload each -------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT proname, count(*) AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND proname IN ('landed_cost_bill_encumbrance',
                       'landed_cost_bill_block_reason',
                       'landed_cost_assert_bill_unencumbered',
                       '_landed_cost_guard_vendor_credit_note',
                       '_landed_cost_annotate_reversal_intent',
                       'resolve_reversal_intent')
     GROUP BY proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION 'probe 1: % has % overloads, expected exactly 1', r.proname, r.n;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND proname IN ('landed_cost_bill_encumbrance',
                         'landed_cost_bill_block_reason',
                         'landed_cost_assert_bill_unencumbered',
                         '_landed_cost_guard_vendor_credit_note')) <> 4 THEN
    RAISE EXCEPTION 'probe 1: bill-encumbrance authority is incomplete';
  END IF;
END $$;

-- 2. encumbrance reads the allocation truth, not a copy of it --------------
DO $$
DECLARE d text := pg_get_functiondef(
  (SELECT oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND proname = 'landed_cost_bill_encumbrance'));
BEGIN
  IF d NOT LIKE '%landed_cost_vouchers%' OR d NOT LIKE '%landed_cost_components%' THEN
    RAISE EXCEPTION 'probe 2: encumbrance must read vouchers and their components';
  END IF;
  -- both linkages: header-level source bill and per-component source bill
  IF d NOT LIKE '%source_bill_id%' THEN
    RAISE EXCEPTION 'probe 2: encumbrance must follow source_bill_id';
  END IF;
  -- draft/cancelled/reversed vouchers encumber nothing
  IF d NOT LIKE '%''reversed''%' OR d NOT LIKE '%''draft''%' THEN
    RAISE EXCEPTION 'probe 2: only live vouchers may encumber a bill';
  END IF;
END $$;

-- 3. the guard is attached to every credit-note write path -----------------
DO $$
DECLARE t record;
BEGIN
  SELECT tgtype INTO t
    FROM pg_trigger
   WHERE tgname = 'trg_landed_cost_guard_vendor_credit_note'
     AND tgrelid = 'public.vendor_credit_notes'::regclass
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'probe 3: credit-note guard trigger is not attached';
  END IF;
  -- BEFORE (bit 1 set), row-level (bit 0), INSERT (bit 2) and UPDATE (bit 4)
  IF (t.tgtype & 1) = 0 OR (t.tgtype & 2) = 0
     OR (t.tgtype & 4) = 0 OR (t.tgtype & 16) = 0 THEN
    RAISE EXCEPTION 'probe 3: guard must be a BEFORE INSERT OR UPDATE row trigger (tgtype %)', t.tgtype;
  END IF;
END $$;

-- 4. the guard fires at draft time and again at posting -------------------
DO $$
DECLARE d text := pg_get_functiondef(
  (SELECT oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND proname = '_landed_cost_guard_vendor_credit_note'));
BEGIN
  IF d NOT LIKE '%landed_cost_assert_bill_unencumbered%' THEN
    RAISE EXCEPTION 'probe 4: guard must delegate to the single assertion';
  END IF;
  IF d NOT LIKE '%accounting_status%' OR d NOT LIKE '%posted%' THEN
    RAISE EXCEPTION 'probe 4: guard must re-assert when the credit note is posted';
  END IF;
  IF d NOT LIKE '%TG_OP = ''INSERT''%' THEN
    RAISE EXCEPTION 'probe 4: guard must assert at draft creation';
  END IF;
END $$;

-- 5. the private applier stays private; read helpers are app-callable ------
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.landed_cost_assert_bill_unencumbered(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.landed_cost_assert_bill_unencumbered(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'probe 5: the assertion must not be a client-callable RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.landed_cost_bill_encumbrance(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.landed_cost_bill_block_reason(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'probe 5: the app must be able to read why a bill is blocked';
  END IF;
END $$;

-- 6. reversal guidance is annotated, never forked --------------------------
DO $$
DECLARE
  dispatch text := pg_get_functiondef(
    (SELECT oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND proname = 'resolve_reversal_intent'));
  annot text := pg_get_functiondef(
    (SELECT oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND proname = '_landed_cost_annotate_reversal_intent'));
BEGIN
  IF dispatch NOT LIKE '%_landed_cost_annotate_reversal_intent%'
     OR dispatch NOT LIKE '%resolve_reversal_intent_finance%' THEN
    RAISE EXCEPTION 'probe 6: bills must reach finance''s verdict through the annotator';
  END IF;
  IF dispatch NOT LIKE '%''goods_receipt'', ''bill''%' THEN
    RAISE EXCEPTION 'probe 6: the bill document type must be annotated too';
  END IF;
  IF annot NOT LIKE '%landed_cost_bill_encumbrance%'
     OR annot NOT LIKE '%landed_cost_receipt_encumbrance%' THEN
    RAISE EXCEPTION 'probe 6: annotator must cover both bill and receipt scope';
  END IF;
  IF annot NOT LIKE '%vendor_credit_note%' OR annot NOT LIKE '%reverse_landed_cost%' THEN
    RAISE EXCEPTION 'probe 6: annotator must block crediting and offer the reversal route';
  END IF;
  -- the annotator must not decide the document''s own lifecycle
  IF annot LIKE '%INSERT INTO%' OR annot LIKE '%UPDATE public.%' THEN
    RAISE EXCEPTION 'probe 6: the annotator is read-only';
  END IF;
END $$;

-- 7. live-data invariant: no credited bill still carries a live landed cost -
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.vendor_credit_notes vcn
   WHERE vcn.bill_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.landed_cost_vouchers lv
        WHERE lv.status NOT IN ('draft', 'cancelled', 'reversed')
          AND (lv.source_bill_id = vcn.bill_id
               OR EXISTS (SELECT 1 FROM public.landed_cost_components c
                           WHERE c.voucher_id = lv.id AND c.source_bill_id = vcn.bill_id)));
  IF n > 0 THEN
    RAISE EXCEPTION 'probe 7: % credit note(s) sit on a bill with a live landed cost', n;
  END IF;
END $$;

ROLLBACK;
