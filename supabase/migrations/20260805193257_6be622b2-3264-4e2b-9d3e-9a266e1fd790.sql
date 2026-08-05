-- ============================================================
-- Label retention (Phase 6 item 5)
--
-- label_print_run_lines is the highest-cardinality table in the
-- subsystem: 50k lines per run, one row per physical label. The run
-- header carries the counters that make the audit statement, so the
-- lines are the disposable half once the run is old and finished.
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_label_run_lines(
  p_retention_days integer DEFAULT 90,
  p_max_rows integer DEFAULT 50000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_retention_days, 90), 7));
  v_limit integer := LEAST(GREATEST(COALESCE(p_max_rows, 50000), 1000), 500000);
  v_lines integer := 0;
  v_demand integer := 0;
BEGIN
  WITH doomed AS (
    SELECT l.id
    FROM public.label_print_run_lines l
    JOIN public.label_print_runs r ON r.id = l.run_id
    WHERE r.status IN ('completed','cancelled','failed')
      AND COALESCE(r.completed_at, r.updated_at) < v_cutoff
    LIMIT v_limit
  )
  DELETE FROM public.label_print_run_lines l
  USING doomed d WHERE l.id = d.id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  -- Dismissed demand is a decision, not a record worth keeping forever.
  DELETE FROM public.label_demand
  WHERE status = 'dismissed' AND updated_at < v_cutoff;
  GET DIAGNOSTICS v_demand = ROW_COUNT;

  RETURN jsonb_build_object(
    'lines_purged', v_lines,
    'demand_purged', v_demand,
    'cutoff', v_cutoff,
    'more_to_do', v_lines >= v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_label_run_lines(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.purge_label_run_lines(integer, integer) TO service_role;

-- Nightly, off-peak. The function is bounded per call; a very large
-- backlog drains over consecutive nights rather than in one long lock.
SELECT cron.unschedule('purge-label-run-lines-nightly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-label-run-lines-nightly');

SELECT cron.schedule(
  'purge-label-run-lines-nightly',
  '25 3 * * *',
  $cron$ SELECT public.purge_label_run_lines(90, 50000); $cron$
);