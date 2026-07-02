
-- =====================================================================
-- 1. payroll_return_runs: add state-machine + idempotency columns
-- =====================================================================

ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS state_transitioned_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS previous_status text,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS amends_run_id uuid REFERENCES public.payroll_return_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE public.payroll_return_runs
SET idempotency_key = encode(digest(
  template_code || ':' || period_start::text || ':' || period_end::text || ':' || business_id::text || ':' || COALESCE(amends_run_id::text,'root'),
  'sha256'), 'hex')
WHERE idempotency_key IS NULL;

ALTER TABLE public.payroll_return_runs
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_return_runs_active_slot_uidx
  ON public.payroll_return_runs (business_id, template_code, period_start, period_end)
  WHERE status <> 'superseded';

-- Drop country-hardcoded submission_channel CHECK — publisher-driven now.
ALTER TABLE public.payroll_return_runs
  DROP CONSTRAINT IF EXISTS payroll_return_runs_submission_channel_check;

-- =====================================================================
-- 2. pack_return_run_audit — every transition is recorded
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.pack_return_run_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_return_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid,
  reason text,
  payload_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pack_return_run_audit TO authenticated;
GRANT ALL ON public.pack_return_run_audit TO service_role;

ALTER TABLE public.pack_return_run_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pack_return_run_audit read own org"
ON public.pack_return_run_audit FOR SELECT TO authenticated
USING (public.is_org_member(auth.uid(), organization_id));

CREATE INDEX IF NOT EXISTS pack_return_run_audit_run_idx
  ON public.pack_return_run_audit(run_id, created_at DESC);

-- =====================================================================
-- 3. payroll_return_transition() — the ONLY sanctioned mutation path
-- =====================================================================

CREATE OR REPLACE FUNCTION public.payroll_return_transition(
  _run_id uuid,
  _to_status text,
  _reason text DEFAULT NULL,
  _payload jsonb DEFAULT '{}'::jsonb
)
RETURNS public.payroll_return_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _run public.payroll_return_runs;
  _allowed boolean := false;
  _actor uuid := auth.uid();
BEGIN
  SELECT * INTO _run FROM public.payroll_return_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return run % not found', _run_id USING ERRCODE = 'P0002';
  END IF;

  IF _actor IS NOT NULL AND NOT public.is_org_member(_actor, _run.organization_id) THEN
    RAISE EXCEPTION 'not authorized for org %', _run.organization_id USING ERRCODE = '42501';
  END IF;

  _allowed := CASE _run.status
    WHEN 'draft'                  THEN _to_status IN ('generated','rejected')
    WHEN 'generated'              THEN _to_status IN ('submitted_awaiting_ack','rejected','superseded')
    WHEN 'submitted_awaiting_ack' THEN _to_status IN ('acknowledged','rejected','superseded')
    WHEN 'acknowledged'           THEN _to_status IN ('filed','superseded')
    WHEN 'filed'                  THEN _to_status IN ('superseded')
    WHEN 'rejected'               THEN _to_status IN ('draft')
    ELSE false
  END;

  IF NOT _allowed THEN
    RAISE EXCEPTION 'illegal return-run transition % -> %', _run.status, _to_status
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_return_runs
     SET previous_status = status,
         status = _to_status,
         state_transitioned_at = now(),
         failure_reason = CASE WHEN _to_status = 'rejected' THEN _reason ELSE failure_reason END,
         updated_at = now()
   WHERE id = _run_id
   RETURNING * INTO _run;

  INSERT INTO public.pack_return_run_audit
    (run_id, organization_id, business_id, from_status, to_status, actor_user_id, reason, payload, payload_hash)
  VALUES
    (_run.id, _run.organization_id, _run.business_id, _run.previous_status, _to_status, _actor, _reason,
     COALESCE(_payload,'{}'::jsonb),
     encode(digest(COALESCE(_payload::text,''), 'sha256'), 'hex'));

  RETURN _run;
END $$;

REVOKE ALL ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) TO authenticated, service_role;

-- =====================================================================
-- 4. Outbox unique index + emission triggers (same-txn, no dual-write)
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS business_event_outbox_idempotency_key_uidx
  ON public.business_event_outbox(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- return.state_changed
CREATE OR REPLACE FUNCTION public.trg_emit_return_run_state_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, actor_user_id, idempotency_key)
  VALUES
    (NEW.organization_id,
     'return.state_changed',
     'payroll_return_run',
     NEW.run_id,
     jsonb_build_object(
       'run_id', NEW.run_id,
       'from_status', NEW.from_status,
       'to_status', NEW.to_status,
       'business_id', NEW.business_id,
       'reason', NEW.reason
     ),
     NEW.actor_user_id,
     'return.state_changed:' || NEW.id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS emit_return_state_changed ON public.pack_return_run_audit;
CREATE TRIGGER emit_return_state_changed
AFTER INSERT ON public.pack_return_run_audit
FOR EACH ROW EXECUTE FUNCTION public.trg_emit_return_run_state_changed();

-- pack.published
CREATE OR REPLACE FUNCTION public.trg_emit_pack_published()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key)
  VALUES
    (NULL,
     'pack.published',
     'pack_version',
     NEW.id,
     jsonb_build_object('pack_id', NEW.pack_id, 'version', NEW.version, 'published_at', NEW.published_at),
     'pack.published:' || NEW.id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS emit_pack_published ON public.pack_versions;
CREATE TRIGGER emit_pack_published
AFTER INSERT ON public.pack_versions
FOR EACH ROW EXECUTE FUNCTION public.trg_emit_pack_published();

-- pack.upgraded / pack.rolled_back
CREATE OR REPLACE FUNCTION public.trg_emit_pack_upgrade_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    _event := CASE NEW.status
      WHEN 'applied' THEN 'pack.upgraded'
      WHEN 'rolled_back' THEN 'pack.rolled_back'
      ELSE NULL
    END;
    IF _event IS NOT NULL THEN
      INSERT INTO public.business_event_outbox
        (org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key)
      VALUES
        (NEW.organization_id,
         _event,
         'pack_upgrade_proposal',
         NEW.id,
         jsonb_build_object('proposal_id', NEW.id, 'pack_id', NEW.pack_id, 'from_status', OLD.status, 'to_status', NEW.status),
         _event || ':' || NEW.id::text || ':' || NEW.status)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS emit_pack_upgrade_state ON public.pack_upgrade_proposals;
CREATE TRIGGER emit_pack_upgrade_state
AFTER UPDATE ON public.pack_upgrade_proposals
FOR EACH ROW EXECUTE FUNCTION public.trg_emit_pack_upgrade_state();
