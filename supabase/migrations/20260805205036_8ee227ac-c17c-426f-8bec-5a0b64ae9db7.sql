CREATE OR REPLACE FUNCTION public.purge_label_runs(
  p_business_id uuid,
  p_older_than_days integer DEFAULT 0,
  p_run_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_deleted integer := 0;
BEGIN
  IF p_business_id IS NULL OR NOT public.user_has_business_access(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'purge_label_runs: no access' USING ERRCODE = '42501';
  END IF;

  WITH doomed AS (
    SELECT id FROM public.label_print_runs
     WHERE business_id = p_business_id
       AND status IN ('completed','cancelled','failed')
       AND (p_run_ids IS NULL OR id = ANY(p_run_ids))
       AND (COALESCE(p_older_than_days,0) = 0
            OR COALESCE(completed_at, created_at) < now() - make_interval(days => p_older_than_days))
  ), del AS (
    DELETE FROM public.label_print_runs r USING doomed d
     WHERE r.id = d.id
     RETURNING r.id
  )
  SELECT count(*)::int INTO v_deleted FROM del;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_label_runs(uuid, integer, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.purge_label_runs(uuid, integer, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_label_runs(uuid, integer, uuid[]) TO service_role;