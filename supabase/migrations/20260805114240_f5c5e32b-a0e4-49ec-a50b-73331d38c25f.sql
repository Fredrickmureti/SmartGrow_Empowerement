CREATE OR REPLACE FUNCTION public.print_jobs_strand(p_ids uuid[], p_reason text DEFAULT 'stranded: owning session never reported back')
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.print_jobs pj
     SET status     = 'abandoned',
         failed_at  = COALESCE(pj.failed_at, now()),
         last_error = COALESCE(NULLIF(p_reason, ''), 'stranded'),
         sent_at    = COALESCE(pj.sent_at, now())
   WHERE pj.id = ANY(p_ids)
     AND pj.status IN ('queued', 'sent', 'processing')
     AND (
       auth.role() = 'service_role'
       OR EXISTS (
         SELECT 1 FROM public.user_business_access uba
          WHERE uba.user_id = auth.uid()
            AND uba.business_id = pj.business_id
       )
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.print_jobs_strand(uuid[], text) TO authenticated, service_role;

-- One-off remediation of the historical backlog: rows that were claimed by a
-- session which never reported back. Anything older than one day can never be
-- settled truthfully, so it is closed as abandoned rather than replayed.
UPDATE public.print_jobs
   SET status     = 'abandoned',
       failed_at  = COALESCE(failed_at, now()),
       last_error = COALESCE(last_error, 'stranded: closed by Phase 5.5 ledger remediation')
 WHERE status IN ('sent', 'processing', 'queued')
   AND created_at < now() - interval '1 day';