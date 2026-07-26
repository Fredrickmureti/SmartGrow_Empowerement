CREATE OR REPLACE FUNCTION public.print_job_mark_acked_by_id(p_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count int;
BEGIN
  UPDATE public.print_jobs
     SET status   = 'acked',
         acked_at = COALESCE(acked_at, now()),
         sent_at  = COALESCE(sent_at, now())
   WHERE id = p_id
     AND status IN ('queued', 'sent');
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- If this was a child of a fan-out parent AND every sibling child is
  -- now acked, promote the parent row to acked so the admin view's
  -- top-level filter reflects final delivery.
  UPDATE public.print_jobs p
     SET status   = 'acked',
         acked_at = COALESCE(p.acked_at, now())
   WHERE p.id = (SELECT parent_job_id FROM public.print_jobs WHERE id = p_id)
     AND p.status IN ('queued', 'sent')
     AND NOT EXISTS (
       SELECT 1 FROM public.print_jobs c
        WHERE c.parent_job_id = p.id
          AND c.status <> 'acked'
     );

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.print_job_mark_acked_by_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_mark_acked_by_id(uuid) TO authenticated, service_role;