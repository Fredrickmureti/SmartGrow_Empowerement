-- Phase 4c of the business reversal convergence plan — contract coverage for
-- the single legality authority `public.resolve_reversal_intent`.
--
-- Why this file exists: before the convergence work, each module decided for
-- itself whether a document could be reversed (client-side checks in hooks,
-- ad-hoc SQL in writers). The platform now has ONE authority that answers
-- "what reversal operation is available for this document, and what blocks
-- it". Every drift away from that — a second authority, a document type that
-- silently answers `allowed: true` with no operation, an unknown blocker code
-- the UI cannot render — is a correctness bug that no runtime test would catch.
--
-- Everything here is introspection over `pg_proc` plus read-only probes, so the
-- file is safe to run in any environment (including production) and never
-- mutates data.

-- 1) Exactly one authority, exactly one overload. Two overloads means callers
--    resolve legality by argument shape — the drift this phase removed.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'resolve_reversal_intent must have exactly one overload, found %', v_count;
  END IF;
END $$;

-- 2) The authority runs with a pinned search_path under SECURITY DEFINER; it
--    reads cross-tenant tables and must not be resolvable through a caller's
--    schema.
DO $$
DECLARE v_secdef boolean; v_cfg text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'resolve_reversal_intent must be SECURITY DEFINER';
  END IF;
  IF COALESCE(v_cfg, '') !~* 'search_path' THEN
    RAISE EXCEPTION 'resolve_reversal_intent must pin search_path';
  END IF;
END $$;

-- 3) Every document type the platform can reverse has a branch. A missing
--    branch is worse than an error: the caller receives a default answer for a
--    document the authority never considered.
DO $$
DECLARE v_src text; v_dt text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';

  FOREACH v_dt IN ARRAY ARRAY['invoice','payment','bill','bill_payment','goods_receipt'] LOOP
    IF v_src !~* ('_document_type\s*=\s*''' || v_dt || '''') THEN
      RAISE EXCEPTION 'resolve_reversal_intent has no branch for document type %', v_dt;
    END IF;
  END LOOP;
END $$;

-- 4) The response contract the UI binds to: `allowed`, `operation`,
--    `blockers`, `document_number`, `status`. Renaming any of these silently
--    disables every reversal dialog (they read the keys, not a typed row).
DO $$
DECLARE v_src text; v_key text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';

  FOREACH v_key IN ARRAY ARRAY['allowed','operation','blockers','document_number','status'] LOOP
    IF v_src !~* ('''' || v_key || '''\s*,') THEN
      RAISE EXCEPTION 'resolve_reversal_intent no longer returns the "%" key of its published contract', v_key;
    END IF;
  END LOOP;
END $$;

-- 5) Blocker taxonomy is closed. `ReversalConsequencePreview` and the reversal
--    dialogs map blocker codes to operator guidance; an unmapped code renders
--    as an unexplained refusal. Extending the taxonomy is allowed — but it must
--    be a deliberate edit here plus the client mapping.
DO $$
DECLARE v_src text; v_unknown text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';

  SELECT string_agg(DISTINCT m[1], ', ') INTO v_unknown
    FROM regexp_matches(v_src, $re$_blockers?\s*:?=\s*[^;]*?'([a-z_]{4,})'$re$, 'g') m
   WHERE m[1] NOT IN (
     'already_reversed',   -- document already voided/reversed
     'settled',            -- fully paid / applied; needs credit note or refund
     'bank_reconciled',    -- money leg matched in bank reconciliation
     'period_closed'       -- accounting period locked
   );

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent emits blocker codes outside the published taxonomy: % — map them in the client preview before shipping', v_unknown;
  END IF;
END $$;

-- 6) Operation taxonomy is closed for the same reason: the client routes each
--    operation to exactly one canonical writer.
DO $$
DECLARE v_src text; v_unknown text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_reversal_intent';

  SELECT string_agg(DISTINCT m[1], ', ') INTO v_unknown
    FROM regexp_matches(v_src, $re$'operation',\s*'([a-z_]+)'$re$, 'g') m
   WHERE m[1] NOT IN (
     'none',               -- nothing legal
     'void',               -- unpaid document, straight void
     'reverse_payment',    -- money leg reversal
     'refund',             -- settled AR
     'credit_note',        -- settled AR, ledger-preserving compensation
     'customer_credit',    -- overpayment retained as customer credit
     'vendor_credit_note', -- settled AP compensation
     'goods_return'        -- goods receipt reversal (ADR 0128)
   );

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent advertises operations with no routed writer: %', v_unknown;
  END IF;
END $$;

-- 7) No second legality authority. Domain sagas may keep their own
--    orchestration (payroll, POS) but the allowlist below is the complete set
--    of functions permitted to answer "can this be reversed"; anything else
--    must delegate to `resolve_reversal_intent`.
DO $$
DECLARE v_rogue text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_rogue
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname ~* '(can_reverse|reversal_allowed|is_reversible|can_void)'
     AND p.proname NOT IN (
       'resolve_reversal_intent',
       -- Phase 6 convergence targets: they remain the domain experts, and will
       -- be reached THROUGH resolve_reversal_intent rather than replaced.
       'payroll_run_can_reverse'
     );
  IF v_rogue IS NOT NULL THEN
    RAISE EXCEPTION 'competing reversal legality authorities found: % — route them through resolve_reversal_intent (Phase 6)', v_rogue;
  END IF;
END $$;

-- 8) Behavioural probe: the authority is total. For any real document of a
--    supported type it must return a jsonb object carrying the contract keys —
--    never NULL, never an error. Read-only; skips silently on an empty tenant.
DO $$
DECLARE v_id uuid; v_res jsonb; v_dt text;
BEGIN
  FOREACH v_dt IN ARRAY ARRAY['invoice','payment','bill','bill_payment','goods_receipt'] LOOP
    EXECUTE format('SELECT id FROM public.%I LIMIT 1',
                   CASE v_dt
                     WHEN 'invoice' THEN 'invoices'
                     WHEN 'payment' THEN 'payments'
                     WHEN 'bill' THEN 'bills'
                     WHEN 'bill_payment' THEN 'bill_payments'
                     ELSE 'goods_receipts'
                   END) INTO v_id;
    CONTINUE WHEN v_id IS NULL;

    v_res := public.resolve_reversal_intent(v_dt, v_id);
    IF v_res IS NULL THEN
      RAISE EXCEPTION 'resolve_reversal_intent returned NULL for % %', v_dt, v_id;
    END IF;
    IF NOT (v_res ? 'allowed' AND v_res ? 'operation' AND v_res ? 'blockers') THEN
      RAISE EXCEPTION 'resolve_reversal_intent response for % is missing contract keys: %', v_dt, v_res;
    END IF;
    IF (v_res->>'allowed')::boolean IS TRUE AND COALESCE(v_res->>'operation', 'none') = 'none' THEN
      RAISE EXCEPTION 'resolve_reversal_intent allowed a reversal with no operation for % %', v_dt, v_id;
    END IF;
    IF (v_res->>'allowed')::boolean IS FALSE
       AND jsonb_array_length(COALESCE(v_res->'blockers', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'resolve_reversal_intent refused % % without stating a blocker', v_dt, v_id;
    END IF;
  END LOOP;
END $$;
