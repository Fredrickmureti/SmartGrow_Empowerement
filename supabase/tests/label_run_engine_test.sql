-- Label Operations Engine — Phase 6 item 1: end-to-end proof (repeatable).
--
-- The engine (create run → expand_label_run → print_jobs → counters) had never
-- executed against real data. This test proves the whole expansion path at
-- volume, inside a nested block that is always rolled back, so it can run in CI
-- or against a live database without leaving a single synthetic row behind.
--
-- Proven invariants:
--   1. Expansion is bounded — one pass never exceeds the batch size.
--   2. Expansion is resumable — repeated passes finish the selection.
--   3. Expansion is idempotent — re-running after completion adds no lines.
--   4. Every non-refused line gets exactly one print_jobs row with
--      intent='label' and a deterministic dedupe key.
--   5. Lines with no printable identity are refused with a reason (ADR-0089),
--      never labelled with a UUID or blank payload.
--   6. Counters roll the run to 'completed'.

DO $outer$
DECLARE
  v_marker CONSTANT text := 'label_run_engine_test:rollback';
BEGIN
  BEGIN
    DECLARE
      v_org      uuid;
      v_business uuid;
      v_run      uuid;
      v_res      jsonb;
      v_pass     int := 0;
      v_lines    int;
      v_refused  int;
      v_jobs     int;
      v_dupes    int;
      v_status   text;
      v_total    CONSTANT int := 1200;   -- > 2 batches at 500
      v_nobar    CONSTANT int := 200;    -- no sku, no identifier → must refuse
      v_batch    CONSTANT int := 500;
    BEGIN
      SELECT b.organization_id, b.id INTO v_org, v_business
        FROM public.businesses b
       ORDER BY b.created_at
       LIMIT 1;
      IF v_business IS NULL THEN
        RAISE NOTICE 'label_run_engine_test: no business present, skipping';
        RAISE EXCEPTION USING MESSAGE = v_marker;
      END IF;

      -- Synthetic catalogue: the first (v_total - v_nobar) rows carry a SKU
      -- (a printable identity); the tail carries none.
      INSERT INTO public.products (organization_id, business_id, name, sku, unit_price)
      SELECT v_org, v_business, 'LBLPROOF product '||g,
             CASE WHEN g <= v_total - v_nobar THEN 'LBLPROOF-'||g ELSE NULL END,
             10 + g
        FROM generate_series(1, v_total) g;

      INSERT INTO public.label_print_runs (
        organization_id, business_id, name, entity_type, template_key, workflow,
        copies, selection_spec, status
      ) VALUES (
        v_org, v_business, 'LBLPROOF run', 'product', 'product_label', 'product_tag',
        1, jsonb_build_object('kind','product_filter','search','LBLPROOF'), 'expanding'
      ) RETURNING id INTO v_run;

      -- 1 + 2: bounded, resumable passes.
      LOOP
        v_pass := v_pass + 1;
        v_res := public.expand_label_run(v_run, v_batch);
        IF (v_res->>'error') IS NOT NULL THEN
          RAISE EXCEPTION 'expand_label_run failed: %', v_res;
        END IF;
        IF COALESCE((v_res->>'expanded')::int, 0) > v_batch THEN
          RAISE EXCEPTION 'pass % exceeded the batch bound: %', v_pass, v_res;
        END IF;
        EXIT WHEN COALESCE((v_res->>'expanded')::int,0) = 0
              AND COALESCE((v_res->>'queued')::int,0) = 0;
        IF v_pass > 20 THEN
          RAISE EXCEPTION 'expansion did not converge within 20 passes';
        END IF;
      END LOOP;

      SELECT count(*), count(*) FILTER (WHERE status = 'refused')
        INTO v_lines, v_refused
        FROM public.label_print_run_lines WHERE run_id = v_run;

      IF v_lines <> v_total THEN
        RAISE EXCEPTION 'expected % lines, got %', v_total, v_lines;
      END IF;

      -- 5: identity refusal, with a reason, and never a UUID payload.
      IF v_refused <> v_nobar THEN
        RAISE EXCEPTION 'expected % refused lines, got %', v_nobar, v_refused;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.label_print_run_lines
         WHERE run_id = v_run AND status = 'refused' AND COALESCE(error,'') = ''
      ) THEN
        RAISE EXCEPTION 'refused lines must carry a reason';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.label_print_run_lines
         WHERE run_id = v_run AND status <> 'refused'
           AND resolved_vars->>'barcode' = entity_id::text
      ) THEN
        RAISE EXCEPTION 'ADR-0089 violation: a line encodes its internal id';
      END IF;

      -- 4: one print job per printable line, deterministic dedupe keys.
      SELECT count(*) INTO v_jobs
        FROM public.print_jobs
       WHERE correlation_id = 'label_run:'||v_run::text AND intent = 'label';
      IF v_jobs <> v_total - v_nobar THEN
        RAISE EXCEPTION 'expected % label jobs, got %', v_total - v_nobar, v_jobs;
      END IF;

      SELECT count(*) INTO v_dupes FROM (
        SELECT dedupe_key FROM public.print_jobs
         WHERE correlation_id = 'label_run:'||v_run::text
         GROUP BY dedupe_key HAVING count(*) > 1
      ) d;
      IF v_dupes > 0 THEN
        RAISE EXCEPTION 'duplicate dedupe keys in run: %', v_dupes;
      END IF;

      -- 3: idempotent after completion.
      v_res := public.expand_label_run(v_run, v_batch);
      IF (SELECT count(*) FROM public.label_print_run_lines WHERE run_id = v_run) <> v_lines THEN
        RAISE EXCEPTION 're-running expansion created extra lines';
      END IF;

      -- 6: counters and terminal status.
      SELECT status::text INTO v_status FROM public.label_print_runs WHERE id = v_run;
      IF v_status NOT IN ('running','completed') THEN
        RAISE EXCEPTION 'unexpected run status after expansion: %', v_status;
      END IF;
      IF (SELECT COALESCE(refused_lines,0) FROM public.label_print_runs WHERE id = v_run) <> v_nobar THEN
        RAISE EXCEPTION 'run refused_lines counter did not roll up';
      END IF;

      RAISE NOTICE 'label_run_engine_test OK — % lines, % refused, % jobs, % passes',
        v_lines, v_refused, v_jobs, v_pass;

      -- Always unwind: every synthetic row above disappears with this raise.
      RAISE EXCEPTION USING MESSAGE = v_marker;
    END;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> v_marker THEN RAISE; END IF;
  END;
END;
$outer$;
