-- Phase 3 (POS printing latency): collapse the interactive round trips.

-- 1. Materialize a document record AND submit its output intent in one call,
--    returning the enqueued job rows so the client does not need a follow-up
--    SELECT, plus the organization id so device resolution needs no lookup.
CREATE OR REPLACE FUNCTION public.document_materialize_and_submit_intent(
  p_kind_code        text,
  p_organization_id  uuid,
  p_source_module    text,
  p_source_doc_type  text,
  p_source_doc_id    uuid,
  p_business_id      uuid    DEFAULT NULL,
  p_branch_id        uuid    DEFAULT NULL,
  p_party_kind       text    DEFAULT NULL,
  p_party_id         uuid    DEFAULT NULL,
  p_currency         text    DEFAULT NULL,
  p_locale           text    DEFAULT NULL,
  p_metadata         jsonb   DEFAULT '{}'::jsonb,
  p_document_number  text    DEFAULT NULL,
  p_document_date    date    DEFAULT NULL,
  p_snapshot         jsonb   DEFAULT NULL,
  p_scenario         text    DEFAULT 'default',
  p_triggered_source text    DEFAULT 'api'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_record_id uuid;
  v_result    jsonb;
  v_job_ids   uuid[];
  v_jobs      jsonb;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT public.is_org_member(auth.uid(), p_organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  v_record_id := public.ensure_document_record(
    p_kind_code, p_organization_id, p_source_module, p_source_doc_type,
    p_source_doc_id, p_business_id, p_branch_id, p_party_kind, p_party_id,
    p_currency, p_locale, p_metadata, p_document_number, p_document_date,
    p_snapshot
  );

  v_result := public.submit_document_intent(
    v_record_id, p_scenario, p_triggered_source, NULL
  );

  SELECT COALESCE(array_agg((value #>> '{}')::uuid), ARRAY[]::uuid[])
    INTO v_job_ids
    FROM jsonb_array_elements(COALESCE(v_result->'job_ids', '[]'::jsonb));

  SELECT COALESCE(jsonb_agg(to_jsonb(j) - 'render_params' || jsonb_build_object(
           'render_params', COALESCE(j.render_params, '{}'::jsonb)
         )), '[]'::jsonb)
    INTO v_jobs
    FROM (
      SELECT id, business_id, branch_id, document_record_id, artifact_id,
             disposition::text AS disposition, medium::text AS medium,
             hardware_role, copies, correlation_id, doc_type, doc_id,
             render_params, status
        FROM public.print_jobs
       WHERE id = ANY(v_job_ids)
       ORDER BY created_at
    ) j;

  RETURN v_result
      || jsonb_build_object(
           'document_record_id', v_record_id,
           'organization_id',    p_organization_id,
           'jobs',               v_jobs
         );
END;
$function$;

REVOKE ALL ON FUNCTION public.document_materialize_and_submit_intent(
  text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_materialize_and_submit_intent(
  text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb, text, text
) TO authenticated, service_role;

-- 2. Batch ledger close: sent + acked for N copies in ONE round trip.
CREATE OR REPLACE FUNCTION public.print_jobs_settle(
  p_ids           uuid[],
  p_hw_command_id bigint DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.print_jobs pj
     SET status        = 'acked',
         sent_at       = COALESCE(pj.sent_at, now()),
         acked_at      = COALESCE(pj.acked_at, now()),
         hw_command_id = COALESCE(p_hw_command_id, pj.hw_command_id)
   WHERE pj.id = ANY(p_ids)
     AND pj.status IN ('queued', 'sent')
     AND (
       auth.role() = 'service_role'
       OR EXISTS (
         SELECT 1 FROM public.user_business_access uba
          WHERE uba.user_id = auth.uid()
            AND uba.business_id = pj.business_id
       )
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Promote fan-out parents whose children are now all acked.
  UPDATE public.print_jobs p
     SET status   = 'acked',
         acked_at = COALESCE(p.acked_at, now())
   WHERE p.id IN (
           SELECT DISTINCT parent_job_id FROM public.print_jobs
            WHERE id = ANY(p_ids) AND parent_job_id IS NOT NULL
         )
     AND p.status IN ('queued', 'sent')
     AND NOT EXISTS (
       SELECT 1 FROM public.print_jobs c
        WHERE c.parent_job_id = p.id AND c.status <> 'acked'
     );

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.print_jobs_settle(uuid[], bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.print_jobs_settle(uuid[], bigint) TO authenticated, service_role;