-- While fixing physical count posting, two fiscal outbox helper functions were also
-- identified as stale writers: they used current field names, but omitted the
-- required idempotency_key. Normalize them now so future ledger/fiscal posting
-- flows do not fail at the event boundary.

CREATE OR REPLACE FUNCTION public.enqueue_fiscal_receipt_required(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_document_kind text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_provider_key text;
  v_event_id uuid;
BEGIN
  v_provider_key := public.resolve_fiscal_provider(p_org_id, p_branch_id);

  INSERT INTO public.business_event_outbox (
    org_id,
    business_id,
    branch_id,
    event_type,
    source_doc_type,
    source_doc_id,
    payload,
    idempotency_key
  ) VALUES (
    p_org_id,
    p_business_id,
    p_branch_id,
    'fiscal.receipt_required',
    p_source_doc_type,
    p_source_doc_id,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
      'document_kind', p_document_kind,
      'provider_key', v_provider_key
    ),
    'fiscal.receipt_required:' || p_source_doc_type || ':' || p_source_doc_id::text || ':' || COALESCE(p_document_kind, 'document')
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        updated_at = now()
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_fiscal_receipt_required(p_transmission_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.fiscal_transmissions%ROWTYPE;
  v_event_id uuid;
BEGIN
  SELECT * INTO v_row
    FROM public.fiscal_transmissions
   WHERE id = p_transmission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiscal transmission % not found', p_transmission_id USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id,
    branch_id,
    event_type,
    source_doc_type,
    source_doc_id,
    payload,
    idempotency_key
  ) VALUES (
    v_row.organization_id,
    v_row.branch_id,
    'fiscal.receipt_required',
    v_row.source_doc_type,
    v_row.source_doc_id,
    jsonb_build_object(
      'transmission_id', v_row.id,
      'provider_key', v_row.provider_key,
      'payload', v_row.payload
    ),
    'fiscal.receipt_required:transmission:' || v_row.id::text
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        updated_at = now()
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END
$function$;
