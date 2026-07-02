
-- Track 1 — Multi-branch hardware-queue scoping
-- Branch-scoped overload of claim_next_hardware_command so a worker in
-- branch A cannot lease a queued command for branch B's printer.
-- p_branch_id NULL means "match either branch-less rows OR rows for any
-- branch" (preserves single-branch behavior).
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
      AND (
        p_branch_id IS NULL
        OR branch_id IS NULL
        OR branch_id = p_branch_id
      )
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

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid,text,int,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid,text,int,uuid) TO authenticated, service_role;

-- Branch-scoped overload of claim_next_business_event mirrors the
-- hardware-queue contract. NULL p_branch_id keeps the legacy
-- org-wide behavior used by tenants without branch isolation.
CREATE OR REPLACE FUNCTION public.claim_next_business_event(
  p_org_id uuid,
  p_limit int DEFAULT 1,
  p_claimant text DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
) RETURNS SETOF public.business_event_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claimant text := COALESCE(p_claimant, 'host:' || substr(md5(random()::text), 1, 8));
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM public.business_event_outbox
    WHERE org_id = p_org_id
      AND status IN ('pending','failed')
      AND attempts < 10
      AND (
        p_branch_id IS NULL
        OR branch_id IS NULL
        OR branch_id = p_branch_id
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.business_event_outbox o
  SET status = 'running',
      attempts = o.attempts + 1,
      claimed_at = now(),
      worker_id = v_claimant,
      updated_at = now()
  FROM cte
  WHERE o.id = cte.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_business_event(uuid,int,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_business_event(uuid,int,text,uuid) TO authenticated, service_role;
