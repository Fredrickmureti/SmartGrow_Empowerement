
-- Generic emitter for whitelisted business events called from client-side
-- bulk import handlers (ADR-0074) and the stock movement engine (audit gap #3).
-- Client cannot INSERT into business_event_outbox directly (RLS denies),
-- so this SECURITY DEFINER RPC is the single client-facing entry point.
--
-- Whitelist of event_type prefixes: product.import.*, stock.*
-- Membership check: caller must be in user_business_access for p_org_id.

CREATE OR REPLACE FUNCTION public.emit_business_event(
  p_org_id uuid,
  p_business_id uuid,
  p_event_type text,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_idempotency_key text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_branch_id uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'emit_business_event: authentication required';
  END IF;

  -- Whitelist prefixes: only import and stock events flow through here.
  IF NOT (
    p_event_type LIKE 'product.import.%'
    OR p_event_type LIKE 'stock.%'
  ) THEN
    RAISE EXCEPTION 'emit_business_event: event_type % is not whitelisted', p_event_type;
  END IF;

  -- Caller must be a member of the workspace they are emitting under.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid
      AND uba.business_id = COALESCE(p_business_id, p_org_id)
  ) THEN
    RAISE EXCEPTION 'emit_business_event: caller is not a member of the workspace';
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id,
    branch_id,
    warehouse_id,
    event_type,
    source_doc_type,
    source_doc_id,
    payload,
    idempotency_key,
    actor_user_id,
    source
  ) VALUES (
    p_org_id,
    p_branch_id,
    p_warehouse_id,
    p_event_type,
    p_source_doc_type,
    p_source_doc_id,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('business_id', p_business_id),
    p_idempotency_key,
    v_uid,
    'client_rpc'
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_business_event(uuid, uuid, text, text, uuid, text, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_business_event(uuid, uuid, text, text, uuid, text, jsonb, uuid, uuid) TO authenticated;
