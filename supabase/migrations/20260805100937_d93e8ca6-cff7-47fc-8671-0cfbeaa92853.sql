GRANT SELECT, INSERT ON public.print_traces TO authenticated;
GRANT ALL ON public.print_traces TO service_role;

CREATE INDEX IF NOT EXISTS print_traces_created_at_idx
  ON public.print_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS print_traces_label_created_at_idx
  ON public.print_traces (label, created_at DESC);
CREATE INDEX IF NOT EXISTS print_traces_correlation_id_idx
  ON public.print_traces (correlation_id);

REVOKE EXECUTE ON FUNCTION public.document_materialize_and_submit_intent(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.ensure_document_record(text, uuid, text, text, uuid, uuid, uuid, text, uuid, text, text, jsonb, text, date, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.print_job_insert(uuid, uuid, text, uuid, text, text, uuid, uuid, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.print_job_mark_sent(uuid, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.print_job_mark_acked_by_id(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.print_jobs_settle(uuid[], bigint) FROM anon;