UPDATE public.print_jobs
SET status = 'queued', attempt_count = 0, last_error = NULL,
    next_attempt_at = NULL, failed_at = NULL, updated_at = now()
WHERE intent = 'label'
  AND render_params ? 'run_id'
  AND status = 'failed';