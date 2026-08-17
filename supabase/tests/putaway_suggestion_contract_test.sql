-- Ratchet (R3/R4 milk simulation, 2026-08-17): the receiving → putaway seam.
--
-- Defect found by the live end-to-end run: receive_goods_to_wms called
-- `wms_suggest_putaway_location(uuid,uuid,numeric,uuid)` — a function that has
-- never existed — and inserted `warehouse_id` / `strategy_id` columns that do
-- not exist on wms_putaway_suggestions. Every receiving session therefore
-- aborted at posting with 42883, and putaway tasks that did land carried a NULL
-- destination, so the queue could never be worked.

-- 1. The staging writer must call the real suggestion engine.
DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'receive_goods_to_wms';

  IF v_src IS NULL THEN RAISE EXCEPTION 'receive_goods_to_wms is missing'; END IF;

  IF v_src LIKE '%wms_suggest_putaway_location(%' THEN
    RAISE EXCEPTION 'receive_goods_to_wms calls the non-existent wms_suggest_putaway_location';
  END IF;

  IF v_src NOT LIKE '%suggest_putaway_locations(%' THEN
    RAISE EXCEPTION 'receive_goods_to_wms must resolve destinations via suggest_putaway_locations';
  END IF;
END $$;

-- 2. Every function that writes wms_putaway_suggestions must only use columns
--    that exist on the table.
DO $$
DECLARE v_src text; v_col text;
BEGIN
  FOR v_src IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND pg_get_functiondef(p.oid) LIKE '%INSERT INTO public.wms_putaway_suggestions%'
  LOOP
    FOREACH v_col IN ARRAY ARRAY['warehouse_id','strategy_id'] LOOP
      IF v_src LIKE '%wms_putaway_suggestions%' AND v_src LIKE '%' || v_col || ',%'
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema='public' AND table_name='wms_putaway_suggestions'
                            AND column_name = v_col)
      THEN
        RAISE EXCEPTION 'a writer inserts wms_putaway_suggestions.% which does not exist', v_col;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 3. A suggestion must be executable: complete_putaway_task rejects a bin that
--    cannot hold the full quantity, so full-fit bins must outrank partial ones.
DO $$
BEGIN
  IF pg_get_functiondef('public.suggest_putaway_locations(uuid,uuid,numeric,text)'::regprocedure)
       NOT LIKE '%fit_qty >= p_quantity%' THEN
    RAISE EXCEPTION 'suggest_putaway_locations must rank full-fit bins ahead of partial-fit bins';
  END IF;
END $$;

-- 4. Behavioural: no completed goods receipt line may be left with a putaway
--    task that has no destination bin.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.wms_tasks
   WHERE task_type = 'putaway'
     AND state IN ('pending','available','claimed','in_progress')
     AND destination_location_id IS NULL
     AND created_at >= timestamptz '2026-08-17 00:00:00+00';
  IF v_n > 0 THEN
    RAISE EXCEPTION '% open putaway task(s) have no destination bin', v_n;
  END IF;
END $$;
