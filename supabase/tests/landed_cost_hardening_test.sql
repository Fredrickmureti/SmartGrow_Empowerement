-- Phase 6.2 — Landed Cost domain hardening coverage.
--
-- Why this file exists: landed cost is the one procurement document that writes
-- into three ledgers at once — inventory valuation (cost layers / unit cost),
-- the general ledger (inventory, COGS, clearing) and the approval record. The
-- failure mode is silent: a voucher that capitalises less than it credits, or
-- allocates at currency parity, leaves the books balanced-looking and the stock
-- valuation quietly wrong. These probes assert the invariants that keep the
-- three ledgers in agreement.
--
-- Introspection plus read-only probes only; safe in any environment.

-- 1) One writer per operation, exactly one overload each. Landed cost must not
--    grow a second posting path that skips governance.
DO $$
DECLARE v_name text; v_count int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'landed_cost_allocate_voucher',
    'landed_cost_post_voucher',
    'landed_cost_reverse_voucher',
    '_landed_cost_post_apply'
  ] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% must exist with exactly one overload, found %', v_name, v_count;
    END IF;
  END LOOP;
END $$;

-- 2) The public post entry point is a governance gate, not an applier: it routes
--    through `approval_route` and delegates the ledger work to the private
--    applier. The applier is never callable from the browser.
DO $$
DECLARE v_src text; v_acl aclitem[];
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_post_voucher';

  IF v_src !~* 'approval_route' THEN
    RAISE EXCEPTION 'landed_cost_post_voucher does not route through approval_route — posting would bypass the approval policy';
  END IF;
  IF v_src !~* '_landed_cost_post_apply' THEN
    RAISE EXCEPTION 'landed_cost_post_voucher does not delegate to _landed_cost_post_apply — a second posting path would exist';
  END IF;
  IF v_src !~* 'user_has_business_access' THEN
    RAISE EXCEPTION 'landed_cost_post_voucher does not assert business access';
  END IF;

  SELECT p.proacl INTO v_acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_landed_cost_post_apply';
  IF v_acl IS NOT NULL AND (
       array_to_string(v_acl, ',') LIKE '%authenticated=%'
    OR array_to_string(v_acl, ',') LIKE '%anon=%') THEN
    RAISE EXCEPTION '_landed_cost_post_apply is executable by a client role — posting could bypass governance';
  END IF;
END $$;

-- 3) The approval mirror is the only automatic route from an approved request to
--    a posted voucher, and it re-asserts the no-self-approval rule.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_mirror_approval_to_landed_cost';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'no approval mirror for landed cost — approved vouchers would never post';
  END IF;
  IF v_src !~* 'governance_assert_not_self' THEN
    RAISE EXCEPTION 'the landed cost approval mirror does not assert governance_assert_not_self — a preparer could approve their own voucher';
  END IF;
  IF v_src !~* '_landed_cost_post_apply' THEN
    RAISE EXCEPTION 'the landed cost approval mirror does not post the voucher on approval';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'landed_cost_vouchers' AND NOT t.tgisinternal
       AND t.tgname = 'trg_landed_cost_self_approval') THEN
    RAISE EXCEPTION 'the self-approval guard trigger is missing from landed_cost_vouchers';
  END IF;
END $$;

-- 4) FX is stamped server-side and refused, never defaulted to parity. A missing
--    rate must raise; a posted voucher must not be re-rated afterwards.
DO $$
DECLARE v_src text; v_alloc text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_landed_cost_voucher_fx_stamp';

  IF v_src !~* 'fx_stamp_document' THEN
    RAISE EXCEPTION 'landed cost FX stamping does not use the canonical fx_stamp_document — rates would diverge from the rest of the ledger';
  END IF;
  IF v_src !~* 'cannot be changed' THEN
    RAISE EXCEPTION 'the FX trigger allows the currency/rate of a posted voucher to change — posted history would be rewritten';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'landed_cost_vouchers' AND NOT t.tgisinternal
       AND t.tgname = 'trg_lc_vouchers_fx_stamp') THEN
    RAISE EXCEPTION 'the FX stamp trigger is not attached to landed_cost_vouchers';
  END IF;

  SELECT p.prosrc INTO v_alloc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher';
  IF v_alloc !~* 'exchange_rate IS NULL OR' THEN
    RAISE EXCEPTION 'allocation does not refuse a voucher with no exchange rate — foreign charges would be allocated at parity';
  END IF;
END $$;

-- 5) Allocation is deterministic and loses nothing: a stable line order and an
--    explicit rounding-drift absorption on the last allocation.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_allocate_voucher';

  IF v_src !~* 'ORDER BY gri_id' THEN
    RAISE EXCEPTION 'allocation iterates receipt lines in an undefined order — the same voucher could allocate differently on re-run';
  END IF;
  IF v_src !~* 'v_amount - v_running' THEN
    RAISE EXCEPTION 'allocation does not absorb rounding drift — allocated amounts would not sum to the component total';
  END IF;
  IF v_src !~* 'DELETE FROM public.landed_cost_allocations' THEN
    RAISE EXCEPTION 'a re-allocation does not clear prior allocations — amounts would double';
  END IF;
END $$;

-- 6) Posting goes through the canonical valuation and journal engines, splits
--    capitalised vs expensed from what inventory actually accepted, and credits
--    clearing for the whole charge.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_landed_cost_post_apply';

  IF v_src !~* 'inventory_apply_cost_revaluation' THEN
    RAISE EXCEPTION 'landed cost posting does not use inventory_apply_cost_revaluation — stock valuation would be written by a private path';
  END IF;
  IF v_src !~* 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'landed cost posting does not use post_journal_entry_atomic — the GL would be written outside the shared writer';
  END IF;
  IF v_src !~* 'landed_cost_clearing' THEN
    RAISE EXCEPTION 'landed cost posting does not credit the landed cost clearing account';
  END IF;
  IF v_src !~* 'is_period_locked' THEN
    RAISE EXCEPTION 'landed cost posting does not check the period lock — a closed period could be reopened by a voucher';
  END IF;
  IF v_src !~* 'already_posted' THEN
    RAISE EXCEPTION 'landed cost posting is not idempotent — a retried post would double-capitalise';
  END IF;
  IF v_src !~* 'no Cost of Goods Sold account is configured' THEN
    RAISE EXCEPTION 'landed cost posting does not refuse an expensed remainder with no COGS account — the journal would silently unbalance';
  END IF;
END $$;

-- 7) Reversal compensates through the same engines and demands a reason; it must
--    never delete the original journal.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'landed_cost_reverse_voucher';

  IF v_src !~* 'a reversal reason is required' THEN
    RAISE EXCEPTION 'landed cost reversal does not require a reason';
  END IF;
  IF v_src !~* 'inventory_reverse_cost_revaluation' THEN
    RAISE EXCEPTION 'landed cost reversal does not unwind the inventory revaluation — stock would keep the uplift';
  END IF;
  IF v_src !~* 'post_journal_entry_atomic' THEN
    RAISE EXCEPTION 'landed cost reversal does not post a compensating journal through the shared writer';
  END IF;
  IF v_src ~* 'DELETE\s+FROM\s+public\.journal_entr' THEN
    RAISE EXCEPTION 'landed cost reversal deletes journal history instead of compensating it';
  END IF;
END $$;

-- 8) Governance registry: both landed cost actions are declared, so policy can
--    gate them and the UI can explain them.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO v_missing
    FROM unnest(ARRAY['landed_cost.post','landed_cost.reverse']) k
   WHERE NOT EXISTS (
     SELECT 1 FROM public.governance_action_registry g WHERE g.action_key = k
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'landed cost actions absent from governance_action_registry: %', v_missing;
  END IF;
END $$;

-- 9) Reporting helpers exist server-side, so no client ever sums allocations.
DO $$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'landed_cost_receipt_summary',
    'landed_cost_valuation_attribution',
    'landed_cost_clearing_exposure'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_name) THEN
      RAISE EXCEPTION 'reporting helper %s is missing — the UI would have to aggregate landed cost in the browser', v_name;
    END IF;
  END LOOP;
END $$;

-- 10) Live-data invariants over whatever this environment already holds.
DO $$
DECLARE v_bad int;
BEGIN
  -- Every posted voucher carries the journal it posted.
  SELECT count(*) INTO v_bad FROM public.landed_cost_vouchers
   WHERE status = 'posted' AND journal_entry_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% posted landed cost voucher(s) have no journal entry', v_bad;
  END IF;

  -- Every reversed voucher carries its compensating journal and clears its split.
  SELECT count(*) INTO v_bad FROM public.landed_cost_vouchers
   WHERE status = 'reversed'
     AND (reversal_journal_entry_id IS NULL
          OR COALESCE(capitalized_amount, 0) <> 0
          OR COALESCE(expensed_amount, 0) <> 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% reversed landed cost voucher(s) are not fully unwound', v_bad;
  END IF;

  -- Posted vouchers never sit at parity for a foreign currency.
  SELECT count(*) INTO v_bad FROM public.landed_cost_vouchers
   WHERE status IN ('posted', 'reversed')
     AND (exchange_rate IS NULL OR exchange_rate <= 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% posted landed cost voucher(s) have no usable exchange rate', v_bad;
  END IF;

  -- The journals landed cost produced are balanced.
  SELECT count(*) INTO v_bad FROM (
    SELECT l.journal_entry_id
      FROM public.journal_entry_lines l
      JOIN public.journal_entries j ON j.id = l.journal_entry_id
     WHERE j.source_type = 'landed_cost_voucher'
     GROUP BY l.journal_entry_id
    HAVING ROUND(SUM(COALESCE(l.debit, 0)), 2) <> ROUND(SUM(COALESCE(l.credit, 0)), 2)
  ) x;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% landed cost journal entr(ies) are unbalanced', v_bad;
  END IF;

  -- The capitalised/expensed split on a posted voucher equals the capitalisable
  -- allocation it was derived from.
  SELECT count(*) INTO v_bad FROM (
    SELECT v.id
      FROM public.landed_cost_vouchers v
      JOIN public.landed_cost_allocations a ON a.voucher_id = v.id
      JOIN public.landed_cost_components c ON c.id = a.component_id
     WHERE v.status = 'posted' AND c.is_capitalizable IS TRUE
     GROUP BY v.id, v.capitalized_amount, v.expensed_amount
    HAVING ROUND(COALESCE(v.capitalized_amount, 0) + COALESCE(v.expensed_amount, 0), 2)
         <> ROUND(SUM(COALESCE(a.allocated_amount, 0)), 2)
  ) x;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% posted landed cost voucher(s) capitalise/expense a total that differs from their allocations', v_bad;
  END IF;

  -- Allocations never outlive their voucher scope.
  SELECT count(*) INTO v_bad
    FROM public.landed_cost_allocations a
    LEFT JOIN public.landed_cost_vouchers v ON v.id = a.voucher_id
   WHERE v.id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% orphaned landed cost allocation(s)', v_bad;
  END IF;
END $$;
