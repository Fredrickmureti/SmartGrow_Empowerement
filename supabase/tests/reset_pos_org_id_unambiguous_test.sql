-- Regression guard (2026-08-12): tenant "Wipe all transactional data" aborted
-- with SQLSTATE 42702 — column reference "org_id" is ambiguous — raised inside
-- reset_module__pos. The tables accounting_events / business_event_outbox /
-- business_event_outbox_dead key the tenant on a column literally named
-- `org_id`, which collides with the function parameter of the same name. Both
-- sides of the predicate must be qualified.
--
-- This test also ratchets the coverage fix: a dedicated reset_module__events
-- must sweep those projections for ALL producers, and the orchestrator's
-- residual check must include them so a future gap fails loudly.

DO $$
DECLARE
  v_pos   text;
  v_root  text;
  v_ev    text;
  t       text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_pos
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__pos';

  SELECT pg_get_functiondef(p.oid) INTO v_root
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_organization_data';

  SELECT pg_get_functiondef(p.oid) INTO v_ev
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__events';

  IF v_pos IS NULL THEN RAISE EXCEPTION 'reset_module__pos is missing'; END IF;
  IF v_root IS NULL THEN RAISE EXCEPTION 'reset_organization_data is missing'; END IF;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'reset_module__events is missing'; END IF;

  -- (A) No bare `org_id` on the left-hand side of a predicate anywhere in the
  --     reset functions — that is exactly the 42702 shape.
  IF v_pos ~ '(WHERE|AND|OR)\s+org_id\s*=' THEN
    RAISE EXCEPTION 'reset_module__pos still has an unqualified org_id predicate (42702 risk)';
  END IF;
  IF v_ev ~ '(WHERE|AND|OR)\s+org_id\s*=' THEN
    RAISE EXCEPTION 'reset_module__events has an unqualified org_id predicate (42702 risk)';
  END IF;

  -- (B) The orchestrator runs the events sweep.
  IF v_root !~ 'reset_module__events' THEN
    RAISE EXCEPTION 'reset_organization_data does not call reset_module__events';
  END IF;

  -- (C) The residual coverage check includes the event projections.
  FOREACH t IN ARRAY ARRAY[
    'accounting_events',
    'business_event_outbox',
    'business_event_outbox_dead'
  ] LOOP
    IF v_root !~ ('''' || t || '''') THEN
      RAISE EXCEPTION 'reset_organization_data residual check omits %', t;
    END IF;
    IF v_ev !~ ('public\.' || t || '\M|\m' || t || '\M') THEN
      RAISE EXCEPTION 'reset_module__events does not clear %', t;
    END IF;
  END LOOP;
END $$;
