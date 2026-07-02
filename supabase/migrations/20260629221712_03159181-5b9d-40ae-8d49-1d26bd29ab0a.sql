
CREATE OR REPLACE FUNCTION public._payroll_batch_emit_event(
  p_batch       public.payroll_run_groups,
  p_event_type  text,
  p_extra       jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb;
BEGIN
  v_payload := jsonb_build_object(
    'batch_id',         p_batch.id,
    'batch_number',     p_batch.batch_number,
    'organization_id',  p_batch.organization_id,
    'business_id',      p_batch.business_id,
    'pay_schedule_id',  p_batch.pay_schedule_id,
    'period_start',     p_batch.period_start,
    'period_end',       p_batch.period_end,
    'run_type',         p_batch.run_type,
    'status',           p_batch.status,
    'actor_user_id',    v_actor
  ) || COALESCE(p_extra, '{}'::jsonb);

  INSERT INTO public.business_event_outbox(
    org_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  )
  VALUES (
    p_batch.organization_id,
    p_event_type,
    'payroll_batch',
    p_batch.id,
    v_payload,
    'payroll_batch:' || p_batch.id::text || ':' || p_event_type
                    || ':' || p_batch.status,
    v_actor,
    'payroll_batch_rpc'
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION public._payroll_batch_emit_event(public.payroll_run_groups, text, jsonb) FROM PUBLIC;
