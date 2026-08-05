CREATE OR REPLACE FUNCTION public.purge_label_runs(p_business_id uuid, p_older_than_days integer DEFAULT 0, p_run_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_deleted integer := 0; v_ids uuid[];
BEGIN
  IF p_business_id IS NULL OR NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'purge_label_runs: no access' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO v_ids
    FROM public.label_print_runs
   WHERE business_id = p_business_id
     AND status IN ('completed','cancelled','failed')
     AND (p_run_ids IS NULL OR id = ANY(p_run_ids))
     AND (COALESCE(p_older_than_days,0) = 0
          OR COALESCE(completed_at, created_at) < now() - make_interval(days => p_older_than_days));

  IF array_length(v_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- The queue rows are part of the run's footprint: leaving them behind
  -- strands failed/dead-lettered jobs that no longer have a run to explain
  -- them, which is exactly the noise the purge exists to remove.
  DELETE FROM public.print_jobs
   WHERE intent = 'label'
     AND business_id = p_business_id
     AND (render_params->>'run_id')::uuid = ANY(v_ids);

  DELETE FROM public.label_print_runs WHERE id = ANY(v_ids);
  v_deleted := array_length(v_ids, 1);

  RETURN v_deleted;
END;
$function$;

-- One-off: label jobs whose run header is already gone.
DELETE FROM public.print_jobs pj
 WHERE pj.intent = 'label'
   AND pj.render_params ? 'run_id'
   AND NOT EXISTS (
     SELECT 1 FROM public.label_print_runs r
      WHERE r.id = (pj.render_params->>'run_id')::uuid
   );