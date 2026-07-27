CREATE OR REPLACE FUNCTION public.submit_document_intent(
  p_document_record_id uuid,
  p_scenario text DEFAULT 'default'::text,
  p_triggered_source text DEFAULT 'api'::text,
  p_override_targets jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_doc         public.document_records%ROWTYPE;
  v_plan        jsonb;
  v_intent_id   uuid;
  v_targets     jsonb;
  v_target      jsonb;
  v_job_id      uuid;
  v_job_ids     uuid[] := ARRAY[]::uuid[];
  v_correlation text;
  v_target_id   uuid;
  v_dedupe      text;
BEGIN
  SELECT * INTO v_doc FROM public.document_records WHERE id = p_document_record_id;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'document_record_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF auth.role() <> 'service_role'
     AND NOT public.is_org_member(auth.uid(), v_doc.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_override_targets IS NOT NULL THEN
    v_intent_id := NULL;
    v_targets   := p_override_targets;
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
    v_target_id   := (v_target->>'id')::uuid;
    v_correlation := encode(extensions.gen_random_bytes(12), 'hex');
    v_dedupe      := v_doc.id::text
                  || ':' || COALESCE(v_target_id::text, v_target->>'medium' || ':' || COALESCE(v_target->>'disposition',''))
                  || ':' || p_scenario
                  || ':' || COALESCE(v_doc.version::text, '1');

    INSERT INTO public.print_jobs (
      business_id, branch_id,
      doc_type, doc_id,
      intent, format,
      correlation_id, transport, status,
      document_record_id, output_intent_id, output_intent_target_id,
      disposition, medium, hardware_role, copies,
      scenario, triggered_source, render_params, requested_by,
      dedupe_key
    ) VALUES (
      COALESCE(v_doc.business_id, v_doc.organization_id),
      v_doc.branch_id,
      v_doc.kind_code, v_doc.id,
      COALESCE(v_target->>'disposition', 'print'),
      COALESCE(v_target->>'medium', 'pdf'),
      v_correlation,
      COALESCE(v_target->>'hardware_role', 'virtual'),
      'queued',
      v_doc.id, v_intent_id, v_target_id,
      (v_target->>'disposition')::public.output_disposition,
      (v_target->>'medium')::public.output_medium,
      v_target->>'hardware_role',
      COALESCE((v_target->>'copies')::smallint, 1),
      p_scenario, p_triggered_source,
      COALESCE(v_target->'params', '{}'::jsonb),
      CASE WHEN auth.role() = 'service_role' THEN NULL ELSE auth.uid() END,
      v_dedupe
    )
    ON CONFLICT (business_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'processing')
      DO NOTHING
    RETURNING id INTO v_job_id;

    IF v_job_id IS NOT NULL THEN
      v_job_ids := v_job_ids || v_job_id;
    END IF;
  END LOOP;

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
    'intent_id',   v_intent_id,
    'scenario',    p_scenario,
    'job_ids',     to_jsonb(v_job_ids),
    'target_count', COALESCE(jsonb_array_length(v_targets), 0)
  );
END
$function$;