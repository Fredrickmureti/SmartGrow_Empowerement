-- Inventory Foundation Wave · Phase 6 — event fabric ratchet.
-- Fails if the single-emitter rule, the movement-class registry, topic
-- registration, handler-scope routing or the lifecycle emitters regress.
BEGIN;

DO $$
DECLARE
  v_def text;
  v_count int;
  v_topic text;
  v_type text;
BEGIN
  -- 1. exactly ONE event emitter trigger on stock_movements
  SELECT count(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE c.relname = 'stock_movements'
     AND NOT t.tgisinternal
     AND pg_get_functiondef(p.oid) LIKE '%business_event_outbox%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ADR0142/P6: % trigger(s) on stock_movements write business_event_outbox directly; the emitter must go through emit_inventory_event', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE c.relname = 'stock_movements'
     AND NOT t.tgisinternal
     AND p.proname = 'tg_stock_movement_emit_event';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ADR0142/P6: expected exactly one tg_stock_movement_emit_event trigger on stock_movements, found %', v_count;
  END IF;

  -- the retired POS-only emitter must be gone
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_stock_movement_emit_event_fn'
  ) THEN
    RAISE EXCEPTION 'ADR0142/P6: the POS-only emitter trg_stock_movement_emit_event_fn is back';
  END IF;

  -- 2. the single emitter seam exists and routes handler_scope from the registry
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'emit_inventory_event';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ADR0142/P6: emit_inventory_event is missing';
  END IF;
  IF v_def NOT LIKE '%business_event_topics%' OR v_def NOT LIKE '%handler_scope%' THEN
    RAISE EXCEPTION 'ADR0142/P6: emit_inventory_event no longer routes handler_scope from business_event_topics';
  END IF;
  IF v_def NOT LIKE '%INVENTORY_UNREGISTERED_EVENT_TOPIC%' THEN
    RAISE EXCEPTION 'ADR0142/P6: emit_inventory_event no longer fails closed on unregistered topics';
  END IF;

  -- 3. the movement emitter covers every allowed movement_type via the registry
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_stock_movement_emit_event';
  IF v_def NOT LIKE '%inventory_movement_event_classes%'
     OR v_def NOT LIKE '%emit_inventory_event%' THEN
    RAISE EXCEPTION 'ADR0142/P6: the movement emitter no longer derives its topic from the registry';
  END IF;
  IF v_def NOT LIKE '%INVENTORY_UNMAPPED_MOVEMENT_TOPIC%' THEN
    RAISE EXCEPTION 'ADR0142/P6: the movement emitter no longer fails closed on unmapped movement types';
  END IF;

  FOR v_type IN
    SELECT unnest(enum_range_from_check.arr)
    FROM (
      SELECT string_to_array(
        replace(replace(replace(
          substring(pg_get_constraintdef(oid) from '\{(.*)\}'),
          '''', ''), '::text', ''), ' ', ''), ',') AS arr
        FROM pg_constraint
       WHERE conrelid = 'public.stock_movements'::regclass
         AND conname = 'stock_movements_movement_type_check'
    ) enum_range_from_check
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.inventory_movement_event_classes
       WHERE movement_type = v_type
    ) THEN
      RAISE EXCEPTION 'ADR0142/P6: movement_type % has no event class registered', v_type;
    END IF;
  END LOOP;

  -- 4. every inventory topic the emitters use is registered, server-scoped
  FOREACH v_topic IN ARRAY ARRAY[
    'inventory.movement.recorded',
    'inventory.lot.quarantined',
    'inventory.lot.released',
    'inventory.lot.recall_opened',
    'inventory.lot.recall_closed',
    'inventory.serial.status_changed',
    'inventory.valuation.revalued',
    'inventory.valuation.revaluation_reversed'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_topics
       WHERE topic_prefix = v_topic AND handler_scope = 'server'
    ) THEN
      RAISE EXCEPTION 'ADR0142/P6: topic % is not registered with server handler scope', v_topic;
    END IF;
  END LOOP;

  -- 5. lifecycle emitters are installed on their owning tables
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'lot_quarantine' AND t.tgname = 'trg_lot_quarantine_emit_event') THEN
    RAISE EXCEPTION 'ADR0142/P6: lot quarantine emitter is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'product_recalls' AND t.tgname = 'trg_product_recall_emit_event') THEN
    RAISE EXCEPTION 'ADR0142/P6: recall emitter is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'stock_serials' AND t.tgname = 'trg_stock_serial_emit_event') THEN
    RAISE EXCEPTION 'ADR0142/P6: serial lifecycle emitter is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'inventory_cost_revaluations' AND t.tgname = 'trg_inventory_revaluation_emit_event') THEN
    RAISE EXCEPTION 'ADR0142/P6: revaluation emitter is not installed';
  END IF;
END $$;

ROLLBACK;
