CREATE OR REPLACE FUNCTION public._rfq_emit(_rfq public.rfqs, _event text, _payload jsonb, _actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_payload jsonb;
BEGIN
  v_payload := COALESCE(_payload, '{}'::jsonb)
    || jsonb_build_object('rfq_id', _rfq.id, 'rfq_number', _rfq.rfq_number,
                          'business_id', _rfq.business_id, 'version', _rfq.version);
  INSERT INTO business_event_outbox (org_id, branch_id, event_type, source_doc_type,
    source_doc_id, payload, idempotency_key, actor_user_id, source)
  VALUES (_rfq.organization_id, _rfq.branch_id, _event, 'rfq', _rfq.id, v_payload,
    _event || ':' || _rfq.id::text || ':' || _rfq.version::text || ':' || md5(v_payload::text),
    _actor, 'rfq')
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;