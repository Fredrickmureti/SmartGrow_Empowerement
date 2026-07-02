ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS amends_run_id uuid REFERENCES public.payroll_return_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS state_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS state_updated_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_return_runs_idem_uidx
  ON public.payroll_return_runs (business_id, template_code, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.pack_return_run_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_return_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_return_run_audit_run_idx
  ON public.pack_return_run_audit (run_id, created_at DESC);

ALTER TABLE public.pack_return_run_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pack_return_run_audit_read ON public.pack_return_run_audit;
CREATE POLICY pack_return_run_audit_read ON public.pack_return_run_audit
  FOR SELECT USING (public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS pack_return_run_audit_service_write ON public.pack_return_run_audit;
CREATE POLICY pack_return_run_audit_service_write ON public.pack_return_run_audit
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.payroll_return_transition(
  _run_id uuid, _to_status text, _reason text DEFAULT NULL, _payload jsonb DEFAULT '{}'::jsonb
) RETURNS public.payroll_return_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_run public.payroll_return_runs;
  v_prev text;
  v_actor uuid := auth.uid();
  v_valid boolean := false;
BEGIN
  SELECT * INTO v_run FROM public.payroll_return_runs WHERE id = _run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run % not found', _run_id USING ERRCODE='P0002'; END IF;
  v_prev := v_run.status;
  IF v_prev = _to_status THEN RETURN v_run; END IF;
  v_valid := CASE v_prev
    WHEN 'draft'        THEN _to_status IN ('generated','cancelled')
    WHEN 'generated'    THEN _to_status IN ('filed','superseded','cancelled','draft')
    WHEN 'filed'        THEN _to_status IN ('acknowledged','rejected','superseded')
    WHEN 'rejected'     THEN _to_status IN ('draft','superseded')
    WHEN 'acknowledged' THEN _to_status IN ('archived','superseded')
    WHEN 'superseded'   THEN _to_status IN ('archived')
    WHEN 'cancelled'    THEN _to_status IN ('archived')
    ELSE false
  END;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'illegal transition: % -> %', v_prev, _to_status USING ERRCODE='22023';
  END IF;
  UPDATE public.payroll_return_runs
     SET status = _to_status, state_updated_at = now(), state_updated_by = v_actor
   WHERE id = _run_id RETURNING * INTO v_run;
  INSERT INTO public.pack_return_run_audit
    (run_id, organization_id, business_id, from_status, to_status, actor_user_id, reason, payload)
  VALUES (v_run.id, v_run.organization_id, v_run.business_id, v_prev, _to_status,
          v_actor, _reason, COALESCE(_payload,'{}'::jsonb));
  RETURN v_run;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_return_transition(uuid,text,text,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.emit_return_state_change_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, status, source, idempotency_key, actor_user_id)
  VALUES
    (NEW.organization_id, 'return.state_changed', 'payroll_return_run', NEW.run_id,
     jsonb_build_object('run_id',NEW.run_id,'business_id',NEW.business_id,
                        'from_status',NEW.from_status,'to_status',NEW.to_status,
                        'reason',NEW.reason,'audit_id',NEW.id),
     'PENDING', 'payroll_return_state_machine',
     'return.state:' || NEW.id::text, NEW.actor_user_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pack_return_run_audit_outbox ON public.pack_return_run_audit;
CREATE TRIGGER trg_pack_return_run_audit_outbox
  AFTER INSERT ON public.pack_return_run_audit
  FOR EACH ROW EXECUTE FUNCTION public.emit_return_state_change_event();

CREATE OR REPLACE FUNCTION public.emit_pack_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_event := 'pack.published';
  ELSIF TG_OP = 'UPDATE' AND NEW.version IS DISTINCT FROM OLD.version THEN v_event := 'pack.upgraded';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO public.business_event_outbox
    (org_id, event_type, source_doc_type, source_doc_id, payload, status, source, idempotency_key)
  VALUES
    (COALESCE(NEW.organization_id,'00000000-0000-0000-0000-000000000000'::uuid),
     v_event, 'localization_pack', NEW.id,
     jsonb_build_object('pack_id',NEW.id,'code',NEW.code,'version',NEW.version,'country_code',NEW.country_code),
     'PENDING', 'localization_publisher',
     v_event || ':' || NEW.id::text || ':' || COALESCE(NEW.version::text,'v'));
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='localization_packs') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_localization_packs_outbox ON public.localization_packs';
    EXECUTE 'CREATE TRIGGER trg_localization_packs_outbox
             AFTER INSERT OR UPDATE ON public.localization_packs
             FOR EACH ROW EXECUTE FUNCTION public.emit_pack_lifecycle_event()';
  END IF;
END $$;