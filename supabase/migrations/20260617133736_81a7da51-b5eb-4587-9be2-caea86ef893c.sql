
-- 1. Shared device queue — serialises commands to a single physical
--    device across multiple Electron hosts.
CREATE TYPE public.hardware_command_status AS ENUM ('pending','running','done','failed','dead');

CREATE TABLE public.hardware_command_queue (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  branch_id uuid NULL,
  device_assignment_id uuid NULL REFERENCES public.device_assignments(id) ON DELETE SET NULL,
  role text NOT NULL,
  op text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status public.hardware_command_status NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text NULL,
  claimed_by text NULL,
  claimed_at timestamptz NULL,
  completed_at timestamptz NULL,
  business_event_id uuid NULL REFERENCES public.business_event_outbox(id) ON DELETE SET NULL,
  source_doc_type text NULL,
  source_doc_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX hardware_command_queue_pending_idx
  ON public.hardware_command_queue (org_id, role, status, created_at)
  WHERE status IN ('pending','failed');

GRANT SELECT ON public.hardware_command_queue TO authenticated;
GRANT ALL ON public.hardware_command_queue TO service_role;

ALTER TABLE public.hardware_command_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY hcq_org_read ON public.hardware_command_queue FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_business_access uba WHERE uba.user_id = auth.uid() AND uba.business_id = hardware_command_queue.org_id));

CREATE POLICY hcq_no_client_write ON public.hardware_command_queue FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY hcq_no_client_update ON public.hardware_command_queue FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- Enqueue helper (server-only — UI cannot insert directly).
CREATE OR REPLACE FUNCTION public.enqueue_hardware_command(
  p_org_id uuid, p_branch_id uuid, p_device_assignment_id uuid,
  p_role text, p_op text, p_payload jsonb, p_idempotency_key text,
  p_business_event_id uuid DEFAULT NULL,
  p_source_doc_type text DEFAULT NULL, p_source_doc_id uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.hardware_command_queue (
    org_id, branch_id, device_assignment_id, role, op, payload,
    idempotency_key, business_event_id, source_doc_type, source_doc_id, created_by
  ) VALUES (
    p_org_id, p_branch_id, p_device_assignment_id, p_role, p_op,
    COALESCE(p_payload,'{}'::jsonb), p_idempotency_key,
    p_business_event_id, p_source_doc_type, p_source_doc_id, auth.uid()
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_hardware_command(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_hardware_command(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,uuid) TO authenticated, service_role;

-- Claim with SKIP LOCKED so two hosts targeting the same shared device
-- can't double-dispatch the same row.
CREATE OR REPLACE FUNCTION public.claim_next_hardware_command(
  p_org_id uuid, p_claimant text, p_limit int DEFAULT 1
) RETURNS SETOF public.hardware_command_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM public.hardware_command_queue
    WHERE org_id = p_org_id AND status IN ('pending','failed') AND attempts < max_attempts
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.hardware_command_queue q
  SET status = 'running', attempts = q.attempts + 1,
      claimed_by = p_claimant, claimed_at = now()
  FROM cte WHERE q.id = cte.id
  RETURNING q.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_hardware_command(uuid,text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_hardware_command(uuid,text,int) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_hardware_command(
  p_id bigint, p_success boolean, p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.hardware_command_queue
  SET status = CASE
        WHEN p_success THEN 'done'::public.hardware_command_status
        WHEN attempts >= max_attempts THEN 'dead'::public.hardware_command_status
        ELSE 'failed'::public.hardware_command_status END,
      last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
      completed_at = CASE WHEN p_success THEN now() ELSE completed_at END
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_hardware_command(bigint,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_hardware_command(bigint,boolean,text) TO authenticated, service_role;

-- 2. Governed reprint requests — every reprint logs a reason + actor.
CREATE TABLE public.reprint_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  branch_id uuid NULL,
  document_kind text NOT NULL,           -- 'receipt','grn_label','shipping_label','payslip','asset_tag', ...
  source_doc_type text NOT NULL,
  source_doc_id uuid NOT NULL,
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  approved_by uuid NULL,
  approved_at timestamptz NULL,
  fulfilled_at timestamptz NULL,
  hardware_exec_log_id uuid NULL,        -- back-pointer when actually printed
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reprint_requests_doc_idx ON public.reprint_requests (source_doc_type, source_doc_id);
CREATE INDEX reprint_requests_org_idx ON public.reprint_requests (org_id, created_at DESC);

GRANT SELECT ON public.reprint_requests TO authenticated;
GRANT ALL ON public.reprint_requests TO service_role;

ALTER TABLE public.reprint_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY reprint_requests_org_read ON public.reprint_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_business_access uba WHERE uba.user_id = auth.uid() AND uba.business_id = reprint_requests.org_id));

CREATE POLICY reprint_requests_no_client_write ON public.reprint_requests FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY reprint_requests_no_client_update ON public.reprint_requests FOR UPDATE TO authenticated USING (false) WITH CHECK (false);

-- RPC: file a reprint request. Requires a non-empty reason. Caller must
-- have org access. Admin / owner roles may auto-approve; everyone else
-- creates a pending request.
CREATE OR REPLACE FUNCTION public.request_reprint(
  p_org_id uuid, p_branch_id uuid, p_document_kind text,
  p_source_doc_type text, p_source_doc_id uuid, p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_auto_approve boolean;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reprint requires a non-empty reason' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_business_access uba
                 WHERE uba.user_id = auth.uid() AND uba.business_id = p_org_id) THEN
    RAISE EXCEPTION 'no access to organization' USING ERRCODE = '42501';
  END IF;

  v_auto_approve := public.has_role(auth.uid(), p_org_id, 'admin'::app_role)
                 OR public.has_role(auth.uid(), p_org_id, 'owner'::app_role);

  INSERT INTO public.reprint_requests (
    org_id, branch_id, document_kind, source_doc_type, source_doc_id,
    reason, requested_by, approved_by, approved_at, metadata
  ) VALUES (
    p_org_id, p_branch_id, p_document_kind, p_source_doc_type, p_source_doc_id,
    p_reason, auth.uid(),
    CASE WHEN v_auto_approve THEN auth.uid() ELSE NULL END,
    CASE WHEN v_auto_approve THEN now() ELSE NULL END,
    COALESCE(p_metadata,'{}'::jsonb)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_reprint(uuid,uuid,text,text,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_reprint(uuid,uuid,text,text,uuid,text,jsonb) TO authenticated, service_role;

-- 3. Cross-module reach — emit payment.received for cash payments so the
--    existing event saga can open a cash drawer on Finance-side cash
--    receipts (not just POS sales).
CREATE OR REPLACE FUNCTION public.tg_payments_emit_received()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status IN ('completed','posted'))
     OR (TG_OP = 'UPDATE' AND NEW.status IN ('completed','posted')
         AND OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.publish_business_event(
      NEW.business_id,
      NEW.branch_id,
      NULL,
      'payment.received',
      'payment',
      NEW.id,
      jsonb_build_object(
        'amount', NEW.amount,
        'method', NEW.payment_method::text,
        'contact_id', NEW.contact_id,
        'receipt_number', NEW.receipt_number
      ),
      'payment-received:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_emit_received ON public.payments;
CREATE TRIGGER payments_emit_received
  AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_emit_received();
