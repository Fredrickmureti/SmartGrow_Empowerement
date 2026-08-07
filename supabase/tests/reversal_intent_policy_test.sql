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
       -- `assert_*` helpers ENFORCE a decision inside a writer; they do not
       -- advertise availability to the UI, so they are not competing
       -- authorities. They must stay assertions — if one starts returning an
       -- availability answer to callers, it belongs behind the intent resolver.
       'assert_can_void_je',
       'assert_can_reverse_payroll',
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
--    never NULL, never a crash. Read-only. Skips silently on an empty tenant and
--    when the session has no org membership (the authority correctly refuses a
--    non-member with 42501, which is the tenancy guard doing its job, not a
--    contract failure).
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

    BEGIN
      v_res := public.resolve_reversal_intent(v_dt, v_id);
    EXCEPTION WHEN insufficient_privilege THEN
      CONTINUE;
    END;

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


-- 9) Phase 5.1: the authorization gate is the single legality entry point.
--    Every canonical writer must call `assert_can_reverse`, and the gate itself
--    must exist as a SECURITY DEFINER assertion.
DO $$
DECLARE
  v_missing text;
  v_gate    RECORD;
BEGIN
  SELECT p.prosecdef, p.provolatile INTO v_gate
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assert_can_reverse';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assert_can_reverse is missing — reversal legality has no single gate';
  END IF;
  IF NOT v_gate.prosecdef THEN
    RAISE EXCEPTION 'assert_can_reverse must be SECURITY DEFINER so it can read the intent authority';
  END IF;

  SELECT string_agg(w, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'void_invoice_atomic',
      'void_payment_atomic',
      'void_bill_atomic',
      'void_bill_payment_atomic',
      'void_goods_receipt_atomic'
    ]) AS w
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = w
        AND p.prosrc LIKE '%assert_can_reverse(%'
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'canonical reversal writers bypass the authorization gate: %', v_missing;
  END IF;
END $$;

-- 10) Phase 5.1: writers must not hand-roll the legality checks the gate owns.
--     Only the gate may consult fiscal-period openness or org membership.
DO $$
DECLARE v_rogue text;
BEGIN
  SELECT string_agg(p.proname || ' (' || v.check_name || ')', ', ')
    INTO v_rogue
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL (VALUES
      ('is_period_open',    '%is_period_open(%'),
      ('user_belongs_to_org', '%user_belongs_to_org(%')
    ) AS v(check_name, pattern)
   WHERE n.nspname = 'public'
     AND p.proname IN ('void_invoice_atomic','void_payment_atomic','void_bill_atomic',
                       'void_bill_payment_atomic','void_goods_receipt_atomic')
     AND p.prosrc LIKE v.pattern;

  IF v_rogue IS NOT NULL THEN
    RAISE EXCEPTION 'writers duplicate gate-owned legality checks: % — delete them and rely on assert_can_reverse', v_rogue;
  END IF;
END $$;

-- 11) Behavioural probe: the gate refuses an operation the intent matrix does
--     not advertise, and refuses an unknown document. Read-only.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.invoices LIMIT 1;
  IF v_id IS NOT NULL THEN
    BEGIN
      PERFORM public.assert_can_reverse('invoice', v_id, 'not_a_real_operation', NULL, CURRENT_DATE);
      RAISE EXCEPTION 'assert_can_reverse permitted an operation the intent matrix does not offer';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;   -- tenancy guard, not a contract failure
      WHEN feature_not_supported THEN NULL;    -- expected refusal
    END;
  END IF;

  BEGIN
    PERFORM public.assert_can_reverse('invoice', '00000000-0000-0000-0000-000000000000'::uuid, 'void', NULL, CURRENT_DATE);
    RAISE EXCEPTION 'assert_can_reverse accepted a document that does not exist';
  EXCEPTION
    WHEN no_data_found THEN NULL;
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ============================================================================
-- Phase 5.3 — approval thresholds
-- ============================================================================

-- 12) The policy surface exists and is tenant-scoped.
DO $$
BEGIN
  IF to_regclass('public.reversal_approval_policies') IS NULL THEN
    RAISE EXCEPTION 'reversal_approval_policies is missing — Phase 5.3 threshold storage';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.reversal_approval_policies'::regclass) THEN
    RAISE EXCEPTION 'reversal_approval_policies has RLS disabled — thresholds would leak across tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.reversal_approval_policies'::regclass) THEN
    RAISE EXCEPTION 'reversal_approval_policies has no RLS policies';
  END IF;
END $$;

-- 13) The requirement resolver and the request entrypoint both exist, and the
--     shared gate consults the resolver rather than re-deriving thresholds.
DO $$
DECLARE v_gate text;
BEGIN
  IF to_regprocedure('public.reversal_approval_requirement(text,uuid,text,date)') IS NULL THEN
    RAISE EXCEPTION 'reversal_approval_requirement is missing';
  END IF;
  IF to_regprocedure('public.request_reversal_approval(text,uuid,text,text,text,date)') IS NULL THEN
    RAISE EXCEPTION 'request_reversal_approval is missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_gate
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'assert_can_reverse';

  IF v_gate !~ 'reversal_approval_requirement' THEN
    RAISE EXCEPTION 'assert_can_reverse does not consult reversal_approval_requirement — approval thresholds are unenforced';
  END IF;
END $$;

-- 14) Every reversal action key is registered with the governance registry, so
--     approvers can be routed by the one approval engine.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(k, ', ')
  INTO v_missing
  FROM unnest(ARRAY[
    'reversal.invoice','reversal.payment','reversal.bill',
    'reversal.bill_payment','reversal.goods_receipt'
  ]) AS k
  WHERE NOT EXISTS (
    SELECT 1 FROM public.governance_action_registry g WHERE g.action_key = k
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'reversal actions absent from governance_action_registry: %', v_missing;
  END IF;
END $$;
