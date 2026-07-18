
ALTER TABLE public.business_event_topics
  ADD COLUMN IF NOT EXISTS handler_scope text NOT NULL DEFAULT 'server'
    CHECK (handler_scope IN ('server','host')),
  ADD COLUMN IF NOT EXISTS max_attempts int;

UPDATE public.business_event_topics
   SET handler_scope = 'host'
 WHERE topic_prefix IN ('payment.received');

CREATE OR REPLACE FUNCTION public.pos_topic_handler_scope(p_event_type text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT handler_scope
       FROM public.business_event_topics
      WHERE p_event_type LIKE topic_prefix || '%'
      ORDER BY length(topic_prefix) DESC
      LIMIT 1),
    'server'
  );
$$;

CREATE OR REPLACE FUNCTION public.pos_topic_max_attempts(p_event_type text)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT max_attempts
       FROM public.business_event_topics
      WHERE p_event_type LIKE topic_prefix || '%'
        AND max_attempts IS NOT NULL
      ORDER BY length(topic_prefix) DESC
      LIMIT 1),
    10
  );
$$;

CREATE TABLE IF NOT EXISTS public.business_event_outbox_dead (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  branch_id uuid,
  warehouse_id uuid,
  event_type text NOT NULL,
  source_doc_type text NOT NULL,
  source_doc_id uuid NOT NULL,
  payload jsonb,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  idempotency_key text,
  actor_user_id uuid,
  source text,
  worker_id text,
  first_attempt_at timestamptz,
  original_created_at timestamptz,
  dead_reason text NOT NULL,
  dead_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_event_outbox_dead_org_idx
  ON public.business_event_outbox_dead (org_id, dead_at DESC);
CREATE INDEX IF NOT EXISTS business_event_outbox_dead_event_type_idx
  ON public.business_event_outbox_dead (event_type);

GRANT SELECT ON public.business_event_outbox_dead TO authenticated;
GRANT ALL ON public.business_event_outbox_dead TO service_role;

ALTER TABLE public.business_event_outbox_dead ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dlq_read_org_members" ON public.business_event_outbox_dead
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
     WHERE uba.user_id = auth.uid()
       AND uba.business_id = business_event_outbox_dead.org_id
  )
);

CREATE OR REPLACE FUNCTION public.move_business_event_to_dlq(
  p_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.business_event_outbox%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.business_event_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.business_event_outbox_dead (
    id, org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    attempts, last_error, idempotency_key, actor_user_id, source, worker_id,
    first_attempt_at, original_created_at, dead_reason
  ) VALUES (
    v_row.id, v_row.org_id, v_row.branch_id, v_row.warehouse_id, v_row.event_type,
    v_row.source_doc_type, v_row.source_doc_id, v_row.payload,
    v_row.attempts, v_row.last_error, v_row.idempotency_key, v_row.actor_user_id,
    v_row.source, v_row.worker_id,
    v_row.claimed_at, v_row.created_at, p_reason
  )
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.business_event_outbox WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_business_event(
  p_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.business_event_outbox%ROWTYPE;
  v_max int;
BEGIN
  SELECT * INTO v_row FROM public.business_event_outbox WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_success THEN
    UPDATE public.business_event_outbox
       SET status = 'succeeded'::public.business_event_status,
           last_error = NULL,
           completed_at = now(),
           updated_at = now()
     WHERE id = p_id;
    RETURN;
  END IF;

  v_max := public.pos_topic_max_attempts(v_row.event_type);

  IF v_row.attempts >= v_max THEN
    UPDATE public.business_event_outbox
       SET last_error = p_error,
           updated_at = now()
     WHERE id = p_id;
    PERFORM public.move_business_event_to_dlq(
      p_id,
      COALESCE(p_error, 'max_attempts_exceeded')
    );
  ELSE
    UPDATE public.business_event_outbox
       SET status = 'failed'::public.business_event_status,
           last_error = p_error,
           updated_at = now()
     WHERE id = p_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_next_business_event(
  p_org_id uuid,
  p_limit integer,
  p_claimant text,
  p_branch_id uuid,
  p_handler_scope text
)
RETURNS SETOF public.business_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimant text := COALESCE(
    p_claimant,
    p_handler_scope || ':' || substr(md5(random()::text), 1, 8)
  );
BEGIN
  IF p_handler_scope NOT IN ('server','host') THEN
    RAISE EXCEPTION 'invalid handler_scope: %', p_handler_scope;
  END IF;

  RETURN QUERY
  WITH cte AS (
    SELECT o.id
      FROM public.business_event_outbox o
     WHERE o.org_id = p_org_id
       AND o.status IN ('pending','failed')
       AND o.attempts < public.pos_topic_max_attempts(o.event_type)
       AND public.pos_topic_handler_scope(o.event_type) = p_handler_scope
       AND (
         p_branch_id IS NULL
         OR o.branch_id IS NULL
         OR o.branch_id = p_branch_id
       )
       AND (
         o.status = 'pending'
         OR o.updated_at < now() - make_interval(secs => least(power(2, o.attempts)::int, 3600))
       )
     ORDER BY o.created_at
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

GRANT EXECUTE ON FUNCTION public.pos_topic_handler_scope(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_topic_max_attempts(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.move_business_event_to_dlq(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_business_event(uuid, integer, text, uuid, text) TO authenticated, service_role;
