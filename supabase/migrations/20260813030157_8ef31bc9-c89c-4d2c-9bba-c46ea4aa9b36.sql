-- 1. Schema drift repair on vendor_statements
ALTER TABLE public.vendor_statements
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS document_record_id uuid REFERENCES public.document_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz;

CREATE INDEX IF NOT EXISTS vendor_statements_branch_idx
  ON public.vendor_statements (business_id, branch_id);

CREATE INDEX IF NOT EXISTS vendor_statements_contact_idx
  ON public.vendor_statements (organization_id, business_id, contact_id);

-- Drop pre-existing duplicates for the same vendor + period, keeping newest.
DELETE FROM public.vendor_statements v
USING public.vendor_statements w
WHERE v.business_id = w.business_id
  AND COALESCE(v.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = COALESCE(w.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  AND v.contact_id = w.contact_id
  AND v.period_start = w.period_start
  AND v.period_end = w.period_end
  AND (v.created_at, v.id) < (w.created_at, w.id);

CREATE UNIQUE INDEX IF NOT EXISTS vendor_statements_period_uq
  ON public.vendor_statements (
    business_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    contact_id,
    period_start,
    period_end
  );

-- 2. Server-authoritative generation (mirrors upsert_customer_statement_atomic)
CREATE OR REPLACE FUNCTION public.upsert_vendor_statement_atomic(_payload jsonb)
RETURNS public.vendor_statements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org      uuid := NULLIF(_payload->>'organization_id','')::uuid;
  v_business uuid := NULLIF(_payload->>'business_id','')::uuid;
  v_branch   uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_contact  uuid := NULLIF(_payload->>'contact_id','')::uuid;
  v_row      public.vendor_statements;
BEGIN
  IF v_org IS NULL OR v_business IS NULL OR v_contact IS NULL THEN
    RAISE EXCEPTION 'organization_id, business_id and contact_id are required';
  END IF;
  IF NOT public.is_org_member(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_contact AND c.organization_id = v_org AND c.business_id = v_business
  ) THEN
    RAISE EXCEPTION 'Contact does not belong to this business';
  END IF;

  INSERT INTO public.vendor_statements (
    organization_id, business_id, branch_id, contact_id,
    statement_date, period_start, period_end,
    opening_balance, total_billed, total_payments, closing_balance,
    currency, created_by
  ) VALUES (
    v_org, v_business, v_branch, v_contact,
    COALESCE(NULLIF(_payload->>'statement_date','')::date, CURRENT_DATE),
    (_payload->>'period_start')::date,
    (_payload->>'period_end')::date,
    COALESCE((_payload->>'opening_balance')::numeric, 0),
    COALESCE((_payload->>'total_billed')::numeric, 0),
    COALESCE((_payload->>'total_payments')::numeric, 0),
    COALESCE((_payload->>'closing_balance')::numeric, 0),
    NULLIF(_payload->>'currency',''),
    auth.uid()
  )
  ON CONFLICT (business_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), contact_id, period_start, period_end)
  DO UPDATE SET
    statement_date  = EXCLUDED.statement_date,
    opening_balance = EXCLUDED.opening_balance,
    total_billed    = EXCLUDED.total_billed,
    total_payments  = EXCLUDED.total_payments,
    closing_balance = EXCLUDED.closing_balance,
    currency        = COALESCE(EXCLUDED.currency, public.vendor_statements.currency)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_vendor_statement_atomic(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_vendor_statement_atomic(jsonb) TO authenticated, service_role;

-- 3. Durable AP statement delivery queue
CREATE TABLE IF NOT EXISTS public.vendor_statement_send_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  statement_id uuid NOT NULL REFERENCES public.vendor_statements(id) ON DELETE CASCADE,
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
  CONSTRAINT vendor_statement_send_jobs_status_chk
    CHECK (status IN ('queued','sending','sent','failed'))
);

GRANT SELECT ON public.vendor_statement_send_jobs TO authenticated;
GRANT ALL ON public.vendor_statement_send_jobs TO service_role;

ALTER TABLE public.vendor_statement_send_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view vendor statement send jobs" ON public.vendor_statement_send_jobs;
CREATE POLICY "Org members can view vendor statement send jobs"
  ON public.vendor_statement_send_jobs
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE UNIQUE INDEX IF NOT EXISTS vendor_statement_send_jobs_idem
  ON public.vendor_statement_send_jobs (idempotency_key);
CREATE INDEX IF NOT EXISTS vendor_statement_send_jobs_due
  ON public.vendor_statement_send_jobs (status, next_attempt_at)
  WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS vendor_statement_send_jobs_stmt
  ON public.vendor_statement_send_jobs (statement_id);
CREATE INDEX IF NOT EXISTS vendor_statement_send_jobs_contact
  ON public.vendor_statement_send_jobs (organization_id, business_id, contact_id);

DROP TRIGGER IF EXISTS vendor_statement_send_jobs_touch ON public.vendor_statement_send_jobs;
CREATE TRIGGER vendor_statement_send_jobs_touch
  BEFORE UPDATE ON public.vendor_statement_send_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.enqueue_vendor_statement_send(
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
  v_stmt public.vendor_statements%ROWTYPE;
  v_email text := lower(trim(_recipient_email));
  v_key text;
  v_id uuid;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'Recipient email is required';
  END IF;

  SELECT * INTO v_stmt FROM public.vendor_statements WHERE id = _statement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor statement % not found', _statement_id;
  END IF;

  IF NOT public.is_org_member(auth.uid(), v_stmt.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  v_key := 'vendor_statement:' || _statement_id::text || ':' || v_email;

  INSERT INTO public.vendor_statement_send_jobs (
    organization_id, business_id, branch_id, statement_id, contact_id,
    recipient_email, subject, message, idempotency_key, requested_by
  ) VALUES (
    v_stmt.organization_id, v_stmt.business_id, v_stmt.branch_id, v_stmt.id,
    v_stmt.contact_id, v_email, _subject, _message, v_key, auth.uid()
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.vendor_statement_send_jobs WHERE idempotency_key = v_key;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_vendor_statement_send(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_vendor_statement_send(uuid, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_vendor_statement_send_jobs(_limit integer DEFAULT 10)
RETURNS SETOF public.vendor_statement_send_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.vendor_statement_send_jobs
    WHERE status IN ('queued','sending')
      AND next_attempt_at <= now()
      AND attempts < max_attempts
    ORDER BY next_attempt_at
    LIMIT GREATEST(_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.vendor_statement_send_jobs j
  SET status = 'sending',
      attempts = j.attempts + 1,
      claimed_at = now(),
      next_attempt_at = now() + (interval '2 minutes' * power(2, LEAST(j.attempts, 4)))
  FROM due
  WHERE j.id = due.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_vendor_statement_send_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_vendor_statement_send_jobs(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_vendor_statement_send_job(
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
  v_job public.vendor_statement_send_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.vendor_statement_send_jobs WHERE id = _job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF _success THEN
    UPDATE public.vendor_statement_send_jobs
    SET status = 'sent', completed_at = now(), last_error = NULL
    WHERE id = _job_id;

    UPDATE public.vendor_statements
    SET sent_at = COALESCE(sent_at, now()), sent_to = COALESCE(sent_to, v_job.recipient_email)
    WHERE id = v_job.statement_id;
  ELSE
    UPDATE public.vendor_statement_send_jobs
    SET status = CASE WHEN v_job.attempts >= v_job.max_attempts THEN 'failed' ELSE 'queued' END,
        completed_at = CASE WHEN v_job.attempts >= v_job.max_attempts THEN now() ELSE NULL END,
        last_error = _error
    WHERE id = _job_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_vendor_statement_send_job(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_vendor_statement_send_job(uuid, boolean, text) TO service_role;