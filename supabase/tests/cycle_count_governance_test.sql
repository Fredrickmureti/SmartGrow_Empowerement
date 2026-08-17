-- Cycle count governance invariants (2026-08-17).
--
-- Origin: a posted cycle count showed an empty approver and its Difference
-- Report still read "a supervisor must approve it". Two defects were behind it:
--   1. the count lifecycle RPCs accepted a NULL actor, which both skipped the
--      SoD evaluation and stamped a blank approver;
--   2. the capture-time tolerance classification was never reconciled with the
--      Inventory decision, so reports read a resolved count as pending.
-- These assertions are structural/behavioural ratchets against both.

-- 1. Structural: every count lifecycle RPC refuses an unidentified actor.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_missing
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('physical_count_submit','physical_count_approve',
                       'physical_count_post','physical_count_cancel')
     AND pg_get_functiondef(p.oid) NOT LIKE '%GOV_ACTOR_REQUIRED%';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'count lifecycle RPC(s) accept a NULL actor (no GOV_ACTOR_REQUIRED guard): %', v_missing;
  END IF;
END $$;

-- 2. Behavioural: a NULL actor is refused, not silently accepted.
DO $$
DECLARE v_id uuid; v_ok boolean := false;
BEGIN
  SELECT id INTO v_id FROM public.physical_counts LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;  -- nothing to probe in this database

  BEGIN
    PERFORM public.physical_count_approve(v_id, NULL);
  EXCEPTION
    WHEN insufficient_privilege THEN v_ok := true;   -- 42501 GOV_ACTOR_REQUIRED
    WHEN OTHERS THEN
      -- Any state-machine refusal reached AFTER the actor guard would mean the
      -- guard let a NULL actor through.
      RAISE EXCEPTION 'physical_count_approve(NULL actor) failed for the wrong reason: % / %',
        SQLSTATE, SQLERRM;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'physical_count_approve accepted a NULL actor';
  END IF;
END $$;

-- 3. Structural: the resolution field exists and is constrained.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='wms_count_lines'
       AND column_name='approval_state'
  ) THEN
    RAISE EXCEPTION 'wms_count_lines.approval_state is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='wms_count_lines_approval_state_check'
  ) THEN
    RAISE EXCEPTION 'approval_state is unconstrained — any string could be stored';
  END IF;
END $$;

-- 4. Structural: the sanctioned read path exposes the resolution, so no client
--    has a reason to read wms_count_lines directly to find out who approved.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='get_count_lines';

  IF v_def IS NULL OR v_def NOT LIKE '%approval_state%' OR v_def NOT LIKE '%approval_actor_id%' THEN
    RAISE EXCEPTION 'get_count_lines does not return the approval resolution';
  END IF;
END $$;

-- 5. Behavioural: no posted count session may leave its lines unresolved.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.wms_count_lines l
    JOIN public.wms_count_sessions s ON s.id = l.session_id
   WHERE s.state = 'posted'
     AND l.approval_state = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM public.wms_count_lines r WHERE r.recount_of_line_id = l.id
     );

  IF v_n > 0 THEN
    RAISE EXCEPTION
      '% count line(s) on posted sessions still read as awaiting approval', v_n;
  END IF;
END $$;

-- 6. Behavioural: an approved count never records an approval it cannot
--    attribute, unless it is explicitly marked as a pre-fix backfill.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.physical_counts
   WHERE state IN ('approved','posted')
     AND approved_by IS NULL
     AND approved_at > '2026-08-17'::date;   -- everything created after the fix

  IF v_n > 0 THEN
    RAISE EXCEPTION '% count(s) approved after the fix with no recorded approver', v_n;
  END IF;
END $$;

-- 7. Structural: stock still moves only through the Inventory adjustment path.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='post_count_session';

  IF v_def ~* 'UPDATE\s+public\.stock_quants' OR v_def ~* 'INSERT\s+INTO\s+public\.stock_movements' THEN
    RAISE EXCEPTION 'post_count_session writes stock directly — it must delegate to Inventory';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 6 (canonical governance wave, 2026-08-17): the variance decision is
-- routed through the ONE approval engine, and count paperwork versions itself.
-- ---------------------------------------------------------------------------

-- 8. Structural: Warehouse is a governed module with the variance action.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.governance_action_registry
     WHERE action_key = 'warehouse.count_variance'
  ) THEN
    RAISE EXCEPTION 'warehouse.count_variance is not registered — the variance decision is ungoverned';
  END IF;
END $$;

-- 9. Structural: submission consults the policy layer, not a hardcoded gate.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='physical_count_submit';

  IF v_def IS NULL OR v_def NOT LIKE '%approval_route%' THEN
    RAISE EXCEPTION 'physical_count_submit does not call approval_route — counts bypass the approval engine';
  END IF;
  IF v_def NOT LIKE '%warehouse.count_variance%' THEN
    RAISE EXCEPTION 'physical_count_submit does not route the registered warehouse.count_variance action';
  END IF;
END $$;

-- 10. Structural: no second engine. Warehouse/Inventory count code must not
--     write approval_requests directly; only approval_route/approval_decide may.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ')
    INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('physical_count_approve','physical_count_post',
                       'post_count_session','submit_count_session')
     AND pg_get_functiondef(p.oid) ~* 'INSERT\s+INTO\s+public\.approval_requests';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'count RPC(s) create approval requests outside the engine: %', v_bad;
  END IF;
END $$;

-- 11. Structural: the engine's decision is mirrored back onto the count.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_mirror_approval_to_physical_count'
  ) THEN
    RAISE EXCEPTION 'approval decisions are not mirrored onto physical_counts';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='physical_counts'
       AND column_name='approval_request_id'
  ) THEN
    RAISE EXCEPTION 'physical_counts.approval_request_id is missing — the count cannot point at its request';
  END IF;
END $$;

-- 12. Structural: manual approval cannot bypass a live governance request.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='physical_count_approve';

  IF v_def IS NULL OR v_def NOT LIKE '%GOV_USE_APPROVAL_ENGINE%' THEN
    RAISE EXCEPTION 'physical_count_approve can be used to bypass a pending approval request';
  END IF;
END $$;

-- 13. Behavioural: no count may sit approved/posted while its governance
--     request is still pending — that would be an orphaned decision.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.physical_counts pc
    JOIN public.approval_requests ar ON ar.id = pc.approval_request_id
   WHERE pc.state IN ('approved','posted')
     AND ar.status = 'pending';

  IF v_n > 0 THEN
    RAISE EXCEPTION '% count(s) moved stock while their approval request is still pending', v_n;
  END IF;
END $$;

-- 14. Structural: count paperwork versions itself when the resolution changes.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='ensure_document_record';

  IF v_def IS NULL OR v_def NOT LIKE '%superseded_by = v_id%' THEN
    RAISE EXCEPTION 'ensure_document_record never supersedes a stale snapshot';
  END IF;
  IF v_def NOT LIKE '%wms.count_%' THEN
    RAISE EXCEPTION 'count documents are not in the supersede path — stale paperwork can persist';
  END IF;
END $$;

-- 15. Behavioural: a superseded record always points forward exactly once.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.document_records a
    JOIN public.document_records b ON b.id = a.superseded_by
   WHERE a.source_doc_id IS DISTINCT FROM b.source_doc_id
      OR a.kind_code     IS DISTINCT FROM b.kind_code;

  IF v_n > 0 THEN
    RAISE EXCEPTION '% document record(s) supersede an unrelated document', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Gated-mode proof (Phase 10). SOLO is proven by tests 1-15 above; these pin
-- the STANDARD / STRICT / ADVANCED semantics of the same single engine.
-- ---------------------------------------------------------------------------

-- 16. The action is registered and active, so a tenant can write a rule for it
--     and the Governance settings screen can list it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.governance_action_registry
     WHERE action_key = 'warehouse.count_variance'
       AND module = 'Warehouse'
       AND is_active
  ) THEN
    RAISE EXCEPTION 'warehouse.count_variance is not an active registered governance action';
  END IF;
END $$;

-- 17. STANDARD: routing is decided by approval_rules through the shared
--     matcher. No warehouse-specific threshold logic may exist anywhere else.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='approval_route';

  IF v_def NOT LIKE '%_approval_match_rule%' THEN
    RAISE EXCEPTION 'approval_route no longer resolves policy through _approval_match_rule';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='physical_count_submit';

  IF v_def LIKE '%governance_mode%' OR v_def LIKE '%solo%' THEN
    RAISE EXCEPTION 'physical_count_submit branches on governance mode instead of asking the engine';
  END IF;
END $$;

-- 18. Any rule a tenant writes for the action must target this action key on a
--     live workflow — a dangling rule would silently gate counts forever.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.approval_rules r
   WHERE r.action_name = 'warehouse.count_variance'
     AND r.is_active
     AND r.workflow_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.approval_workflows w
        WHERE w.id = r.workflow_id AND w.is_active
     );

  IF v_n > 0 THEN
    RAISE EXCEPTION '% active count-variance rule(s) point at an inactive workflow', v_n;
  END IF;
END $$;

-- 19. STRICT: the decision itself refuses self-approval, and the refusal is
--     policy-driven (self_action_policy) with single-use overrides honoured.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='approval_decide';
  IF v_def NOT LIKE '%governance_assert_not_self%' THEN
    RAISE EXCEPTION 'approval_decide allows the requester to approve their own request';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='governance_assert_not_self';
  IF v_def NOT LIKE '%self_action_policy%' THEN
    RAISE EXCEPTION 'self-action refusals ignore the per-action policy table';
  END IF;
  IF v_def NOT LIKE '%self_action_overrides%' THEN
    RAISE EXCEPTION 'ADVANCED single-use overrides are not consulted';
  END IF;
END $$;
