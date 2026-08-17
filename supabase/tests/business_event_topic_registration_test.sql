-- Ratchet (P0-4, milk simulation 2026-08-16): every topic that the database
-- actually emits must be registered EXACTLY in public.business_event_topics.
-- Prefix fallback silently routed unregistered topics to the server dispatcher,
-- which had no handler for them, so they dead-lettered as
-- "posting.contract_violation: unknown_event_type" while the operator saw a
-- successful receipt.

-- 1. Structural: every emitted event type is registered by exact topic.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(DISTINCT t.event_type, ', ')
    INTO v_missing
    FROM (
      SELECT event_type FROM public.business_event_outbox
      UNION ALL
      SELECT event_type FROM public.business_event_outbox_dead
    ) t
   WHERE NOT EXISTS (
     SELECT 1 FROM public.business_event_topics bt
      WHERE bt.topic_prefix = t.event_type
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'business_event_topics is missing exact registration for: %', v_missing;
  END IF;
END $$;

-- 2. Behavioural: no event of a warehouse/procurement/inventory lifecycle topic
--    may remain dead-lettered for an unknown event type.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.business_event_outbox_dead
   WHERE dead_reason ILIKE '%unknown_event_type%'
      OR last_error  ILIKE '%unknown_event_type%';

  IF v_n > 0 THEN
    RAISE EXCEPTION
      '% business event(s) dead-lettered as unknown_event_type', v_n;
  END IF;
END $$;

-- 3. Static: a topic must be registered BEFORE it is ever emitted. Checks 1-2
--    can only see topics that already fired; this one reads the emitter source
--    so a brand-new topic cannot ship unregistered and dead-letter in
--    production. Scans every function that calls an outbox emit helper for
--    domain topic literals.
DO $$
DECLARE v_missing text;
BEGIN
  WITH fns AS (
    SELECT pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(p.oid) ~ '(emit_business_event|emit_inventory_event|_wms_emit_event)\s*\('
  ),
  lits AS (
    SELECT DISTINCT m[1] AS topic
      FROM fns,
           regexp_matches(
             fns.def,
             '''((?:warehouse|procurement|inventory|goods_receipt|delivery_note|product|stock|pos)\.[a-z_]+(?:\.[a-z_]+)*)''',
             'g'
           ) m
  )
  SELECT string_agg(l.topic, ', ' ORDER BY l.topic)
    INTO v_missing
    FROM lits l
   WHERE NOT EXISTS (
     SELECT 1 FROM public.business_event_topics bt
      WHERE bt.topic_prefix = l.topic
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'topic(s) emitted by database code but never registered in business_event_topics: %', v_missing;
  END IF;
END $$;
