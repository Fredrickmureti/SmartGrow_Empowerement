-- WMS Product & Inventory Consumer Audit · Phase 5 — event-driven integration.
--
-- Pins the ADR 0101 invariants that Phase 5 repaired:
--   1. Every `warehouse.*` topic literal emitted by a public function is
--      registered in `wms_events_catalog` (yard is explicitly deferred to the
--      yard wave and listed as a known exemption, so a NEW unregistered topic
--      still fails).
--   2. The retired vocabulary (`warehouse.count.opened`,
--      `warehouse.count.submitted`) is not emitted server-side, and the
--      cycle-count session functions no longer double-produce alongside
--      `trg_wms_counts_emit`.
--   3. Every consumer that dispatches on `NEW.event_type` keys off a topic that
--      is registered in the catalog — this is how replenishment- and
--      return-driven cycle counts silently stopped firing.
--   4. Idempotency keys built inside `wms_*` producers use the ADR 0101 shape
--      `wms.{aggregate}:{id}:{transition}`.
--   5. The task / LPN emit triggers exist on INSERT as well as UPDATE, so the
--      Phase 3 split-putaway child task and the Phase 4 plate relocation reach
--      the outbox without their own inline emit.
BEGIN;

DO $$
DECLARE
  v_topic text;
  v_def   text;
  v_count int;
  -- Yard topics are owned by the (out of scope) yard wave. Any topic added
  -- outside this list must be registered.
  v_exempt text[] := ARRAY[
    'warehouse.yard.checked_in','warehouse.yard.docked','warehouse.yard.departed',
    'warehouse.yard.no_show','warehouse.yard.moved','warehouse.yard.move_requested',
    'warehouse.yard.released','warehouse.yard.relocated'
  ];
BEGIN
  -- 1. every emitted topic is catalogued
  FOR v_topic IN
    SELECT DISTINCT m[1]
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL regexp_matches(p.prosrc, '''(warehouse\.[a-z_]+\.[a-z_]+)''', 'g') m
     WHERE n.nspname = 'public'
  LOOP
    IF v_topic = ANY(v_exempt) THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.wms_events_catalog WHERE topic = v_topic) THEN
      RAISE EXCEPTION 'ADR0101/P5: topic % is emitted but not registered in wms_events_catalog', v_topic;
    END IF;
  END LOOP;

  -- 2. retired count vocabulary is gone and the session RPCs do not
  --    double-produce alongside trg_wms_counts_emit
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.prosrc LIKE '%warehouse.count.opened%'
       OR p.prosrc LIKE '%warehouse.count.submitted%');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ADR0101/P5: % function(s) still emit the retired count vocabulary', v_count;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_count_session_as';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0101/P5: create_count_session_as is missing';
  END IF;
  IF v_def LIKE '%business_event_outbox%' THEN
    RAISE EXCEPTION 'ADR0101/P5: create_count_session_as emits in-body; trg_wms_counts_emit is the single producer';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'post_count_session';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0101/P5: post_count_session is missing';
  END IF;
  IF v_def LIKE '%business_event_outbox%' THEN
    RAISE EXCEPTION 'ADR0101/P5: post_count_session emits in-body; trg_wms_counts_emit is the single producer';
  END IF;

  -- the count session emitter still covers the FSM states
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'wms_count_sessions' AND t.tgname = 'trg_wms_counts_emit'
  ) THEN
    RAISE EXCEPTION 'ADR0101/P5: trg_wms_counts_emit is missing — count sessions would go silent';
  END IF;

  -- 3. event-driven consumers dispatch on catalogued topics only
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_wms_count_trigger_from_event';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0101/P5: _wms_count_trigger_from_event is missing';
  END IF;
  IF v_def NOT LIKE '%warehouse.replen.completed%'
     OR v_def NOT LIKE '%warehouse.return.dispositions_posted%'
     OR v_def NOT LIKE '%warehouse.count.posted%'
     OR v_def NOT LIKE '%warehouse.receipt.staged%' THEN
    RAISE EXCEPTION 'ADR0101/P5: the event-driven count trigger no longer keys off the live producer topics';
  END IF;
  IF v_def LIKE '%warehouse.replenishment.completed%'
     OR v_def LIKE '%warehouse.return.dispositioned%' THEN
    RAISE EXCEPTION 'ADR0101/P5: the event-driven count trigger keys off a dead topic — those counts never fire';
  END IF;

  -- 4. labour producer uses the canonical key shape
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'wms_publish_labour_plan';
  IF v_def NOT LIKE '%wms.labour:%' THEN
    RAISE EXCEPTION 'ADR0101/P5: wms_publish_labour_plan does not build wms.{aggregate}:{id}:{transition} keys';
  END IF;

  -- the canonical emitter still defaults + upserts on idempotency_key
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_wms_emit_event';
  IF v_def NOT LIKE '%ON CONFLICT (idempotency_key)%' THEN
    RAISE EXCEPTION 'ADR0101/P5: _wms_emit_event is no longer idempotent on idempotency_key';
  END IF;

  -- 5. task / LPN emitters fire on INSERT too (Phase 3 split child task,
  --    Phase 4 plate relocation)
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'wms_tasks' AND t.tgname = 'trg_wms_tasks_emit'
       AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT OR UPDATE OF state%'
  ) THEN
    RAISE EXCEPTION 'ADR0101/P5: trg_wms_tasks_emit no longer fires on INSERT — split-putaway child tasks would never be announced';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'wms_license_plates' AND t.tgname = 'trg_wms_lpn_moved'
  ) THEN
    RAISE EXCEPTION 'ADR0101/P5: trg_wms_lpn_moved is missing — plate relocations would not reach the outbox';
  END IF;
END $$;

ROLLBACK;
