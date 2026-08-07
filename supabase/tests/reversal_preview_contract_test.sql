-- Phase 4c of the business reversal convergence plan — contract coverage for
-- the consequence projector `public.preview_reversal_consequences` and its core
-- `public.preview_reversal_consequences_core`.
--
-- Why this file exists: the preview is what makes a reversal *explainable*. It
-- is the only place an operator learns, before committing, which journals will
-- be mirrored, which stock will move, which payments will be unapplied and
-- which downstream documents will be touched. It is a pure projection — it must
-- never write — and its section/warning keys are a published contract consumed
-- by `ReversalConsequencePreview`. Silent drift here degrades an auditable
-- reversal into a blind one.
--
-- Introspection plus read-only probes only; safe in any environment.

-- 1) One projector, one core, one overload each.
DO $$
DECLARE v_name text; v_count int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['preview_reversal_consequences','preview_reversal_consequences_core'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must have exactly one overload, found %', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- 2) The preview is derived from the single legality authority — it must not
--    re-decide legality with its own rules.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_reversal_consequences_core';
  IF v_src !~* 'resolve_reversal_intent' THEN
    RAISE EXCEPTION 'preview_reversal_consequences_core no longer derives from resolve_reversal_intent — the preview and the gate would disagree';
  END IF;
END $$;

-- 3) The projector is pure. A preview that writes turns "show me what would
--    happen" into "make it happen".
DO $$
DECLARE v_name text; v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['preview_reversal_consequences','preview_reversal_consequences_core'] LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src ~* '(^|[^a-z_])(insert\s+into|update\s+public\.|delete\s+from)' THEN
      RAISE EXCEPTION '% performs a write — the consequence preview must be a pure projection', v_name;
    END IF;
  END LOOP;
END $$;

-- 4) Every reversible document type is projected. A type covered by the intent
--    authority but not by the preview would gate correctly and then execute
--    without ever telling the operator what it was about to do.
DO $$
DECLARE v_src text; v_dt text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_reversal_consequences_core';

  FOREACH v_dt IN ARRAY ARRAY['invoice','payment','bill','bill_payment','goods_receipt'] LOOP
    IF v_src !~* ('_document_type\s*=\s*''' || v_dt || '''') THEN
      RAISE EXCEPTION 'preview_reversal_consequences_core does not project document type %', v_dt;
    END IF;
  END LOOP;
END $$;

-- 5) Warning taxonomy is closed — the client maps each code to guidance and, in
--    the case of `bank_reconciled`, to a resolve action.
DO $$
DECLARE v_src text; v_unknown text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_reversal_consequences_core';

  SELECT string_agg(DISTINCT m[1], ', ') INTO v_unknown
    FROM regexp_matches(v_src, $re$'code',\s*'([a-z_]+)'$re$, 'g') m
   WHERE m[1] NOT IN (
     'no_gl_entry',
     'bank_reconciled',
     'fiscal_transmitted',
     'delivery_note_linked',
     'credit_note_exists',
     'vendor_credit_note_exists',
     'stock_already_restored',
     'receipt_already_billed',
     'three_way_match_unwound'
   );

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'preview_reversal_consequences_core emits unmapped warning codes: % — add operator guidance in ReversalConsequencePreview first', v_unknown;
  END IF;
END $$;

-- 6) Behavioural probe: the preview is total and shaped. For any real document
--    it returns the section keys the UI renders, and its GL projection mirrors
--    debits and credits (a reversal that is not a mirror is not a reversal).
--    Skips when the session has no org membership (42501 from the tenancy
--    guard) or the tenant is empty.
DO $$
DECLARE v_id uuid; v_res jsonb; v_je jsonb; v_line jsonb;
BEGIN
  SELECT id INTO v_id FROM public.invoices LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  BEGIN
    v_res := public.preview_reversal_consequences('invoice', v_id);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;

  IF v_res IS NULL THEN
    RAISE EXCEPTION 'preview_reversal_consequences returned NULL for invoice %', v_id;
  END IF;

  IF NOT (v_res ? 'gl' AND v_res ? 'warnings') THEN
    RAISE EXCEPTION 'preview_reversal_consequences response is missing published sections: %',
      (SELECT string_agg(k, ',') FROM jsonb_object_keys(v_res) k);
  END IF;

  FOR v_je IN SELECT jsonb_array_elements(COALESCE(v_res->'gl', '[]'::jsonb)) LOOP
    FOR v_line IN SELECT jsonb_array_elements(COALESCE(v_je->'lines', '[]'::jsonb)) LOOP
      IF NOT (v_line ? 'reverse_debit' AND v_line ? 'reverse_credit') THEN
        RAISE EXCEPTION 'GL projection line lacks the mirrored debit/credit contract: %', v_line;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 7) The bank blocker is resolvable: the preview names it and a canonical
--    server-side resolver exists for the operator action wired into every
--    reversal surface (see reversal-writer-monopoly.test.ts).
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('resolve_reversal_bank_block', 'reversal_bank_lines');
  IF v_count < 2 THEN
    RAISE EXCEPTION 'the bank reconciliation blocker has no canonical resolver pair (resolve_reversal_bank_block / reversal_bank_lines)';
  END IF;
END $$;
