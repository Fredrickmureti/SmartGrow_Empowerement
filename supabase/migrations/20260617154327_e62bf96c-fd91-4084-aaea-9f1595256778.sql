-- Track-B liveness gap: business-event handler crash recovery + ops metrics.

-- 1) Lease columns on the outbox so a crashed BusinessSaga host can be
--    reclaimed by another host. Mirrors hardware_command_queue.
ALTER TABLE public.business_event_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS claim_lease_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS worker_id text NULL;

CREATE INDEX IF NOT EXISTS business_event_outbox_running_lease_idx
  ON public.business_event_outbox (claimed_at)
  WHERE status = 'running';

-- 2) Update claim RPC to stamp claim metadata. Keep the old signature for
--    backward compatibility (existing BusinessSaga.ts caller does not pass
--    a claimant yet — we default to host:<random>).
CREATE OR REPLACE FUNCTION public.claim_next_business_event(
  p_org_id uuid,
  p_limit int DEFAULT 1,
  p_claimant text DEFAULT NULL
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

REVOKE ALL ON FUNCTION public.claim_next_business_event(uuid,int,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_business_event(uuid,int,text) TO authenticated, service_role;

-- 3) Reclaim stale events whose worker died mid-handler.
CREATE OR REPLACE FUNCTION public.reclaim_stale_business_events()
RETURNS TABLE(reclaimed_id uuid, prior_worker text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.business_event_outbox o
  SET status = 'pending',
      claimed_at = NULL,
      worker_id = NULL,
      updated_at = now()
  WHERE o.status = 'running'
    AND o.claimed_at IS NOT NULL
    AND o.claimed_at < now() - (o.claim_lease_seconds || ' seconds')::interval
  RETURNING o.id, o.worker_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reclaim_stale_business_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_business_events() TO authenticated, service_role;

-- 4) Lightweight ops view for the operator dashboard card.
CREATE OR REPLACE VIEW public.v_business_event_outbox_health AS
SELECT
  org_id,
  count(*) FILTER (WHERE status = 'failed')                                              AS failed_count,
  count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '5 minutes') AS pending_over_5min,
  count(*) FILTER (WHERE status = 'running' AND claimed_at < now() - (claim_lease_seconds || ' seconds')::interval) AS stale_running,
  COALESCE(
    EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending')))::int,
    0
  ) AS oldest_pending_age_seconds
FROM public.business_event_outbox
GROUP BY org_id;

GRANT SELECT ON public.v_business_event_outbox_health TO authenticated, service_role;