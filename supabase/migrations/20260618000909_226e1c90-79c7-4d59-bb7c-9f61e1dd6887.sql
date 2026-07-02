
-- Wave B1 Step 2.5 (C3) — make next_attempt_at live for the Postgres queue.

CREATE OR REPLACE FUNCTION public.claim_next_hardware_command(
  p_org_id uuid,
  p_claimant text,
  p_limit int DEFAULT 1,
  p_branch_id uuid DEFAULT NULL
) RETURNS SETOF public.hardware_command_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM public.hardware_command_queue
    WHERE org_id = p_org_id
      AND status IN ('pending','failed')
      AND attempts < max_attempts
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (p_branch_id IS NULL OR branch_id IS NULL OR branch_id = p_branch_id)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.hardware_command_queue q
  SET status = 'running',
      attempts = q.attempts + 1,
      claimed_by = p_claimant,
      claimed_at = now()
  FROM cte
  WHERE q.id = cte.id
  RETURNING q.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid)
  IS 'Branch-aware claim. Skips rows whose next_attempt_at is in the future so failed commands actually back off (Wave B1 Step 2.5 C3).';

-- Stamp next_attempt_at on failure with exponential backoff (1s,2s,4s,8s,30s).
CREATE OR REPLACE FUNCTION public.complete_hardware_command(
  p_id bigint, p_success boolean, p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempts int;
  v_backoff_sec int;
BEGIN
  SELECT attempts INTO v_attempts FROM public.hardware_command_queue WHERE id = p_id;
  v_backoff_sec := CASE LEAST(COALESCE(v_attempts, 1), 5)
    WHEN 1 THEN 1
    WHEN 2 THEN 2
    WHEN 3 THEN 4
    WHEN 4 THEN 8
    ELSE 30
  END;

  UPDATE public.hardware_command_queue
  SET status = CASE
        WHEN p_success THEN 'done'::public.hardware_command_status
        WHEN attempts >= max_attempts THEN 'dead'::public.hardware_command_status
        ELSE 'failed'::public.hardware_command_status END,
      last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
      completed_at = CASE WHEN p_success THEN now() ELSE completed_at END,
      next_attempt_at = CASE
        WHEN p_success THEN NULL
        WHEN attempts >= max_attempts THEN NULL
        ELSE now() + make_interval(secs => v_backoff_sec)
      END
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_hardware_command(bigint,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_hardware_command(bigint,boolean,text) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_hardware_command(bigint,boolean,text)
  IS 'Marks a queue row done/failed/dead and stamps next_attempt_at = now + backoff(attempts) on failure (Wave B1 Step 2.5 C3).';
