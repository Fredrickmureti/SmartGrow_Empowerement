CREATE TABLE public.customer_statement_send_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  statement_id uuid NOT NULL REFERENCES public.customer_statements(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  message text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_statement_send_jobs_status_chk
    CHECK (status IN ('queued','sending','sent','failed'))
);

CREATE UNIQUE INDEX customer_statement_send_jobs_idem
  ON public.customer_statement_send_jobs (idempotency_key);

CREATE INDEX customer_statement_send_jobs_due
  ON public.customer_statement_send_jobs (status, next_attempt_at)
  WHERE status IN ('queued','sending');

CREATE INDEX customer_statement_send_jobs_stmt
  ON public.customer_statement_send_jobs (statement_id);

CREATE INDEX customer_statement_send_jobs_contact
  ON public.customer_statement_send_jobs (organization_id, business_id, contact_id);

GRANT SELECT ON public.customer_statement_send_jobs TO authenticated;
GRANT ALL ON public.customer_statement_send_jobs TO service_role;

ALTER TABLE public.customer_statement_send_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view statement send jobs"
  ON public.customer_statement_send_jobs
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE TRIGGER customer_statement_send_jobs_touch
  BEFORE UPDATE ON public.customer_statement_send_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Queue one statement email. Idempotent: the same statement + recipient can
-- never be queued (and therefore never sent) twice.
CREATE OR REPLACE FUNCTION public.enqueue_customer_statement_send(
  _statement_id uuid,
  _recipient_email text,
  _subject text,
  _message text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stmt public.customer_statements%ROWTYPE;
  v_email text := lower(trim(_recipient_email));
  v_key text;
  v_id uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'Recipient email is required';
  END IF;

  SELECT * INTO v_stmt FROM public.customer_statements WHERE id = _statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Statement % not found', _statement_id;
  END IF;

  IF NOT public.is_org_member(auth.uid(), v_stmt.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  v_key := 'customer_statement:' || _statement_id::text || ':' || v_email;

  INSERT INTO public.customer_statement_send_jobs (
    organization_id, business_id, branch_id, statement_id, contact_id,
    recipient_email, subject, message, idempotency_key, requested_by
  ) VALUES (
    v_stmt.organization_id, v_stmt.business_id, v_stmt.branch_id, v_stmt.id,
    v_stmt.contact_id, v_email, _subject, _message, v_key, auth.uid()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.customer_statement_send_jobs
    WHERE idempotency_key = v_key;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_customer_statement_send(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_customer_statement_send(uuid, text, text, text) TO authenticated, service_role;

-- Worker: claim due jobs. SKIP LOCKED so concurrent workers never take the
-- same job, and stale 'sending' rows become due again after their backoff.
CREATE OR REPLACE FUNCTION public.claim_customer_statement_send_jobs(_limit integer DEFAULT 10)
RETURNS SETOF public.customer_statement_send_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.customer_statement_send_jobs
    WHERE status IN ('queued','sending')
      AND next_attempt_at <= now()
      AND attempts < max_attempts
    ORDER BY next_attempt_at
    LIMIT GREATEST(_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.customer_statement_send_jobs j
  SET status = 'sending',
      attempts = j.attempts + 1,
      claimed_at = now(),
      -- Reserve the row for the length of one backoff window; a worker that
      -- dies mid-send releases it automatically instead of blocking forever.
      next_attempt_at = now() + (interval '2 minutes' * power(2, LEAST(j.attempts, 4)))
  FROM due
  WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_customer_statement_send_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_customer_statement_send_jobs(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_customer_statement_send_job(
  _job_id uuid,
  _success boolean,
  _error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.customer_statement_send_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.customer_statement_send_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF _success THEN
    UPDATE public.customer_statement_send_jobs
    SET status = 'sent', completed_at = now(), last_error = NULL
    WHERE id = _job_id;

    UPDATE public.customer_statements
    SET sent_at = COALESCE(sent_at, now()), sent_to = COALESCE(sent_to, v_job.recipient_email)
    WHERE id = v_job.statement_id;
  ELSE
    UPDATE public.customer_statement_send_jobs
    SET status = CASE WHEN v_job.attempts >= v_job.max_attempts THEN 'failed' ELSE 'queued' END,
        completed_at = CASE WHEN v_job.attempts >= v_job.max_attempts THEN now() ELSE NULL END,
        last_error = _error
    WHERE id = _job_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_customer_statement_send_job(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_customer_statement_send_job(uuid, boolean, text) TO service_role;