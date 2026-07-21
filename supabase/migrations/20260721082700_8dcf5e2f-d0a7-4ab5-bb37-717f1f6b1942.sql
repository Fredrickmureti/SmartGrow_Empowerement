-- Phase D1 — Print job ledger (ADR-0090)
-- Delivery observability layer. Every PrintClient.print(...) inserts one
-- row; hardware bridge writes acks back via SECURITY DEFINER RPCs.

CREATE TYPE public.print_job_status AS ENUM (
  'queued', 'sent', 'acked', 'failed', 'abandoned'
);

CREATE TABLE public.print_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  branch_id           uuid NULL,
  doc_type            text NOT NULL,
  doc_id              uuid NULL,
  intent              text NOT NULL,
  format              text NOT NULL,
  printer_profile_id  uuid NULL,
  media_profile_id    uuid NULL,
  correlation_id      text NOT NULL,
  hw_command_id       bigint NULL REFERENCES public.hardware_command_queue(id) ON DELETE SET NULL,
  transport           text NOT NULL,
  status              public.print_job_status NOT NULL DEFAULT 'queued',
  attempt_count       int NOT NULL DEFAULT 0,
  last_error          text NULL,
  requested_by        uuid NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz NULL,
  acked_at            timestamptz NULL,
  failed_at           timestamptz NULL,
  parent_job_id       uuid NULL REFERENCES public.print_jobs(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, correlation_id)
);

CREATE INDEX print_jobs_business_recent_idx
  ON public.print_jobs (business_id, requested_at DESC);
CREATE INDEX print_jobs_status_idx
  ON public.print_jobs (business_id, status, requested_at DESC)
  WHERE status IN ('queued', 'sent', 'failed');
CREATE INDEX print_jobs_hw_command_idx
  ON public.print_jobs (hw_command_id)
  WHERE hw_command_id IS NOT NULL;

GRANT SELECT ON public.print_jobs TO authenticated;
GRANT ALL    ON public.print_jobs TO service_role;

ALTER TABLE public.print_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY print_jobs_read_own_business ON public.print_jobs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = print_jobs.business_id
  ));

-- Explicitly block direct client writes; all mutations go through the
-- SECURITY DEFINER RPCs below.
CREATE POLICY print_jobs_no_client_insert ON public.print_jobs
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY print_jobs_no_client_update ON public.print_jobs
  FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY print_jobs_no_client_delete ON public.print_jobs
  FOR DELETE TO authenticated USING (false);

CREATE OR REPLACE FUNCTION public.print_jobs_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_jobs_updated_at
  BEFORE UPDATE ON public.print_jobs
  FOR EACH ROW EXECUTE FUNCTION public.print_jobs_touch_updated_at();

-- ─────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────

-- Insert a queued row. Idempotent on (business_id, correlation_id):
-- accidental double-click returns the existing row's id instead of a dup.
CREATE OR REPLACE FUNCTION public.print_job_insert(
  p_business_id        uuid,
  p_branch_id          uuid,
  p_doc_type           text,
  p_doc_id             uuid,
  p_intent             text,
  p_format             text,
  p_printer_profile_id uuid,
  p_media_profile_id   uuid,
  p_correlation_id     text,
  p_transport          text,
  p_parent_job_id      uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'print_job_insert: caller has no access to business %', p_business_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.print_jobs (
    business_id, branch_id, doc_type, doc_id, intent, format,
    printer_profile_id, media_profile_id, correlation_id, transport,
    parent_job_id, requested_by, status, attempt_count
  ) VALUES (
    p_business_id, p_branch_id, p_doc_type, p_doc_id, p_intent, p_format,
    p_printer_profile_id, p_media_profile_id, p_correlation_id, p_transport,
    p_parent_job_id, auth.uid(), 'queued', 1
  )
  ON CONFLICT (business_id, correlation_id) DO UPDATE
    SET attempt_count = public.print_jobs.attempt_count + 1,
        updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.print_job_insert(uuid,uuid,text,uuid,text,text,uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_insert(uuid,uuid,text,uuid,text,text,uuid,uuid,text,text,uuid) TO authenticated, service_role;

-- Mark a job as sent to the hardware bridge; attach the hw command id.
CREATE OR REPLACE FUNCTION public.print_job_mark_sent(
  p_id            uuid,
  p_hw_command_id bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.print_jobs
     SET status        = 'sent',
         sent_at       = COALESCE(sent_at, now()),
         hw_command_id = COALESCE(p_hw_command_id, hw_command_id)
   WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.print_job_mark_sent(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_mark_sent(uuid, bigint) TO authenticated, service_role;

-- Ack from the hardware bridge — keyed by hw_command_id so the queue
-- consumer doesn't need to know the print_job.id.
CREATE OR REPLACE FUNCTION public.print_job_mark_acked(
  p_hw_command_id bigint
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  UPDATE public.print_jobs
     SET status   = 'acked',
         acked_at = now()
   WHERE hw_command_id = p_hw_command_id
     AND status IN ('queued', 'sent');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.print_job_mark_acked(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_mark_acked(bigint) TO service_role;

-- Mark failed with an error message; retries increment attempt_count
-- via print_job_insert's ON CONFLICT branch.
CREATE OR REPLACE FUNCTION public.print_job_mark_failed(
  p_id    uuid,
  p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.print_jobs
     SET status     = 'failed',
         failed_at  = now(),
         last_error = left(coalesce(p_error, 'unknown'), 500)
   WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.print_job_mark_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_mark_failed(uuid, text) TO authenticated, service_role;

-- Resend: clones a job with a fresh correlation id so the queue's
-- unique constraint doesn't reject the retry. Old row preserved for audit.
CREATE OR REPLACE FUNCTION public.print_job_resend(
  p_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_src public.print_jobs%ROWTYPE;
  v_new uuid;
BEGIN
  SELECT * INTO v_src FROM public.print_jobs WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'print_job_resend: job % not found', p_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = v_src.business_id
  ) THEN
    RAISE EXCEPTION 'print_job_resend: caller has no access to business %', v_src.business_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.print_jobs (
    business_id, branch_id, doc_type, doc_id, intent, format,
    printer_profile_id, media_profile_id,
    correlation_id, transport, parent_job_id, requested_by,
    status, attempt_count
  ) VALUES (
    v_src.business_id, v_src.branch_id, v_src.doc_type, v_src.doc_id,
    v_src.intent, v_src.format, v_src.printer_profile_id, v_src.media_profile_id,
    v_src.correlation_id || ':resend:' || replace(gen_random_uuid()::text, '-', ''),
    v_src.transport, v_src.id, auth.uid(),
    'queued', 1
  )
  RETURNING id INTO v_new;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.print_job_resend(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_job_resend(uuid) TO authenticated, service_role;

COMMENT ON TABLE public.print_jobs IS
  'Print delivery observability ledger (ADR-0090 · Phase D). One row per PrintClient.print(...) call, correlated with hardware_command_queue via hw_command_id + correlation_id.';