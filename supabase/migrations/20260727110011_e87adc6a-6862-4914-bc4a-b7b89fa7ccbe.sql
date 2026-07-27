
-- =========================================================================
-- REPAIR: Wave 1 aggregate collision.
-- The legacy DMS "documents" table pre-dates Wave 1; CREATE TABLE IF NOT
-- EXISTS therefore did nothing. We create the true aggregate under the
-- name `document_records` and repoint every FK that Waves 1-4 added.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.document_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid,
  branch_id uuid,
  kind_code text NOT NULL REFERENCES public.document_kinds(code),
  version int NOT NULL DEFAULT 1,
  source_module text NOT NULL,
  source_doc_type text,
  source_doc_id uuid,
  source_event_id uuid,
  party_kind text,
  party_id uuid,
  currency text,
  locale text,
  status text NOT NULL DEFAULT 'issued',
  superseded_by uuid REFERENCES public.document_records(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_records_org_kind_idx
  ON public.document_records (organization_id, kind_code, created_at DESC);
CREATE INDEX IF NOT EXISTS document_records_source_idx
  ON public.document_records (source_module, source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS document_records_party_idx
  ON public.document_records (party_kind, party_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_records TO authenticated;
GRANT ALL ON public.document_records TO service_role;
ALTER TABLE public.document_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_records readable by org members" ON public.document_records;
CREATE POLICY "document_records readable by org members"
  ON public.document_records FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "document_records writable by org members" ON public.document_records;
CREATE POLICY "document_records writable by org members"
  ON public.document_records FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "document_records updatable by org members" ON public.document_records;
CREATE POLICY "document_records updatable by org members"
  ON public.document_records FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

DROP TRIGGER IF EXISTS document_records_touch_updated_at ON public.document_records;
CREATE TRIGGER document_records_touch_updated_at
  BEFORE UPDATE ON public.document_records
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- Repoint document_artifacts.document_id FK (was pointing at legacy DMS docs).
DO $$
DECLARE fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'public.document_artifacts'::regclass
    AND contype = 'f'
    AND array_position(conkey, (
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'public.document_artifacts'::regclass AND attname = 'document_id'
    )) IS NOT NULL
  LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.document_artifacts DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

-- Existing rows point at the legacy DMS documents table; NULL them so the
-- new FK to document_records can be added. The pre-repair values are
-- meaningless under the new aggregate.
ALTER TABLE public.document_artifacts ALTER COLUMN document_id DROP NOT NULL;
UPDATE public.document_artifacts SET document_id = NULL WHERE document_id IS NOT NULL;
ALTER TABLE public.document_artifacts
  ADD CONSTRAINT document_artifacts_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES public.document_records(id) ON DELETE CASCADE;

-- Repoint output_dispatch_log.document_id FK.
DO $$
DECLARE fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'public.output_dispatch_log'::regclass
    AND contype = 'f'
    AND array_position(conkey, (
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'public.output_dispatch_log'::regclass AND attname = 'document_id'
    )) IS NOT NULL
  LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.output_dispatch_log DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

UPDATE public.output_dispatch_log SET document_id = NULL WHERE document_id IS NOT NULL;
ALTER TABLE public.output_dispatch_log
  ADD CONSTRAINT output_dispatch_log_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES public.document_records(id) ON DELETE SET NULL;


-- =========================================================================
-- WAVE 5: Unified print/dispatch pipeline
-- =========================================================================

-- Extend print_jobs with intent/target linkage.
ALTER TABLE public.print_jobs
  ADD COLUMN IF NOT EXISTS document_record_id uuid REFERENCES public.document_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS output_intent_id uuid REFERENCES public.output_intents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS output_intent_target_id uuid REFERENCES public.output_intent_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES public.document_artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disposition public.output_disposition,
  ADD COLUMN IF NOT EXISTS medium public.output_medium,
  ADD COLUMN IF NOT EXISTS hardware_role text,
  ADD COLUMN IF NOT EXISTS copies smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS scenario text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS triggered_source text,
  ADD COLUMN IF NOT EXISTS render_params jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS print_jobs_document_record_idx
  ON public.print_jobs (document_record_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS print_jobs_intent_idx
  ON public.print_jobs (output_intent_id);

-- =========================================================================
-- submit_document_intent — the single chokepoint for dispatching a document.
-- Resolves the routing plan (Wave 4) and enqueues one job per target.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.submit_document_intent(
  p_document_record_id uuid,
  p_scenario text DEFAULT 'default',
  p_triggered_source text DEFAULT 'api',
  p_override_targets jsonb DEFAULT NULL   -- optional: skip resolver, use these targets verbatim
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.document_records%ROWTYPE;
  v_plan jsonb;
  v_intent_id uuid;
  v_targets jsonb;
  v_target jsonb;
  v_job_id uuid;
  v_job_ids uuid[] := ARRAY[]::uuid[];
  v_correlation text;
BEGIN
  SELECT * INTO v_doc FROM public.document_records WHERE id = p_document_record_id;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'document_record_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization: caller must be a member of the document's org (unless service_role).
  IF auth.role() <> 'service_role'
     AND NOT public.is_org_member(auth.uid(), v_doc.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_override_targets IS NOT NULL THEN
    v_intent_id := NULL;
    v_targets := p_override_targets;
  ELSE
    v_plan := public.resolve_output_intent(
      v_doc.kind_code, v_doc.organization_id, v_doc.branch_id, p_scenario
    );
    IF NOT COALESCE((v_plan->>'resolved')::boolean, false) THEN
      RAISE EXCEPTION 'no_output_intent_matched (%, %)', v_doc.kind_code, p_scenario;
    END IF;
    v_intent_id := (v_plan->>'intent_id')::uuid;
    v_targets   := COALESCE(v_plan->'targets', '[]'::jsonb);
  END IF;

  FOR v_target IN SELECT * FROM jsonb_array_elements(v_targets)
  LOOP
    v_correlation := encode(gen_random_bytes(12), 'hex');
    INSERT INTO public.print_jobs (
      business_id, branch_id,
      doc_type, doc_id,
      intent, format,
      correlation_id, transport, status,
      document_record_id, output_intent_id, output_intent_target_id,
      disposition, medium, hardware_role, copies,
      scenario, triggered_source, render_params, requested_by
    ) VALUES (
      COALESCE(v_doc.business_id, v_doc.organization_id),
      v_doc.branch_id,
      v_doc.kind_code, v_doc.id,
      COALESCE(v_target->>'disposition', 'print'),
      COALESCE(v_target->>'medium', 'pdf'),
      v_correlation,
      COALESCE(v_target->>'hardware_role', 'virtual'),
      'queued',
      v_doc.id, v_intent_id, (v_target->>'id')::uuid,
      (v_target->>'disposition')::public.output_disposition,
      (v_target->>'medium')::public.output_medium,
      v_target->>'hardware_role',
      COALESCE((v_target->>'copies')::smallint, 1),
      p_scenario, p_triggered_source,
      COALESCE(v_target->'params', '{}'::jsonb),
      CASE WHEN auth.role() = 'service_role' THEN NULL ELSE auth.uid() END
    )
    RETURNING id INTO v_job_id;
    v_job_ids := v_job_ids || v_job_id;
  END LOOP;

  -- Audit dispatch decision.
  INSERT INTO public.output_dispatch_log (
    document_id, document_kind, organization_id, branch_id, scenario,
    intent_id, resolved_targets, triggered_by, triggered_source, status
  ) VALUES (
    v_doc.id, v_doc.kind_code, v_doc.organization_id, v_doc.branch_id, p_scenario,
    v_intent_id, v_targets,
    CASE WHEN auth.role() = 'service_role' THEN NULL ELSE auth.uid() END,
    p_triggered_source,
    CASE WHEN array_length(v_job_ids, 1) > 0 THEN 'dispatched' ELSE 'resolved' END
  );

  RETURN jsonb_build_object(
    'document_record_id', v_doc.id,
    'intent_id', v_intent_id,
    'scenario', p_scenario,
    'job_ids', to_jsonb(v_job_ids),
    'target_count', COALESCE(jsonb_array_length(v_targets), 0)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.submit_document_intent(uuid, text, text, jsonb)
  TO authenticated, service_role;

-- Status transition helpers (workers only).
CREATE OR REPLACE FUNCTION public.mark_print_job_dispatched(
  p_job_id uuid,
  p_artifact_id uuid DEFAULT NULL,
  p_hw_command_id bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.print_jobs
     SET status = 'sent',
         sent_at = now(),
         attempt_count = attempt_count + 1,
         artifact_id = COALESCE(p_artifact_id, artifact_id),
         hw_command_id = COALESCE(p_hw_command_id, hw_command_id)
   WHERE id = p_job_id;
END $$;

GRANT EXECUTE ON FUNCTION public.mark_print_job_dispatched(uuid, uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_print_job_failed(
  p_job_id uuid,
  p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE public.print_jobs
     SET status = 'failed',
         failed_at = now(),
         attempt_count = attempt_count + 1,
         last_error = p_error
   WHERE id = p_job_id;
END $$;

GRANT EXECUTE ON FUNCTION public.mark_print_job_failed(uuid, text) TO service_role;
