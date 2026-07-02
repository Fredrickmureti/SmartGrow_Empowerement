-- Wave B4.1 — Per-assignment claim lock for hardware_command_queue.
-- Adds a 5-arg form that can scope claims to a specific device_assignment_id,
-- so multi-claim or multi-worker scenarios serialize per assignment via
-- FOR UPDATE SKIP LOCKED. The 4-arg form is preserved as a SQL wrapper for
-- back-compat (Postgres does not dispatch on DEFAULT, so an explicit wrapper
-- is mandatory; without it generated types and existing callers would break).

-- 5-arg canonical form. NO DEFAULT on p_device_assignment_id, to avoid
-- ambiguity with the 4-arg wrapper below.
CREATE OR REPLACE FUNCTION public.claim_next_hardware_command(
  p_org_id uuid,
  p_claimant text,
  p_limit int,
  p_branch_id uuid,
  p_device_assignment_id uuid
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
      AND (p_device_assignment_id IS NULL OR device_assignment_id = p_device_assignment_id)
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

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid, uuid)
  IS 'Wave B4.1 — canonical claim function. Branch-aware AND per-device-assignment-aware. Pass NULL p_device_assignment_id to claim across all assignments (default worker behaviour); pass a uuid to serialize claims for that single device assignment under FOR UPDATE SKIP LOCKED.';

-- 4-arg back-compat wrapper. CREATE OR REPLACE flips the previous plpgsql
-- definition to a thin SQL wrapper that delegates to the 5-arg form with
-- p_device_assignment_id => NULL. All existing callers (SharedCommandQueueWorker,
-- generated supabase types, tests) keep working unchanged.
CREATE OR REPLACE FUNCTION public.claim_next_hardware_command(
  p_org_id uuid,
  p_claimant text,
  p_limit int DEFAULT 1,
  p_branch_id uuid DEFAULT NULL
) RETURNS SETOF public.hardware_command_queue
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.claim_next_hardware_command(
    p_org_id, p_claimant, p_limit, p_branch_id, NULL::uuid
  );
$$;

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.claim_next_hardware_command(uuid, text, int, uuid)
  IS 'Wave B4.1 — back-compat 4-arg wrapper. Delegates to the 5-arg canonical form with p_device_assignment_id=NULL. New code should call the 5-arg form directly when per-assignment serialization is required.';