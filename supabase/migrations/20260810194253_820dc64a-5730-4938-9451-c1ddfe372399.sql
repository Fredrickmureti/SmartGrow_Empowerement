
-- 1. RFQ events belong to the server dispatcher, not the browser saga.
CREATE OR REPLACE FUNCTION public._rfq_emit(_rfq public.rfqs, _event text, _payload jsonb, _actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_payload jsonb;
BEGIN
  v_payload := COALESCE(_payload, '{}'::jsonb)
    || jsonb_build_object('rfq_id', _rfq.id, 'rfq_number', _rfq.rfq_number,
                          'business_id', _rfq.business_id, 'version', _rfq.version);
  INSERT INTO business_event_outbox (org_id, branch_id, event_type, source_doc_type,
    source_doc_id, payload, idempotency_key, actor_user_id, source, handler_scope)
  VALUES (_rfq.organization_id, _rfq.branch_id, _event, 'rfq', _rfq.id, v_payload,
    _event || ':' || _rfq.id::text || ':' || _rfq.version::text || ':' || md5(v_payload::text),
    _actor, 'rfq', 'server')
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

-- 2. Delivery attempt bookkeeping on the invitation.
ALTER TABLE public.rfq_invitations
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- 3. Worker: claim queued invitations for one RFQ version.
CREATE OR REPLACE FUNCTION public.rfq_invitations_claim_for_delivery(
  _rfq_id uuid, _max_attempts integer DEFAULT 5, _limit integer DEFAULT 50)
RETURNS TABLE (
  invitation_id uuid, supplier_id uuid, contact_email text,
  rfq_number text, business_id uuid, organization_id uuid,
  response_deadline timestamptz, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT i.id
      FROM rfq_invitations i
      JOIN rfqs r ON r.id = i.rfq_id
     WHERE i.rfq_id = _rfq_id
       AND i.rfq_version = r.version
       AND i.delivery_state IN ('queued', 'failed')
       AND i.delivery_attempts < _max_attempts
     ORDER BY i.created_at
     LIMIT _limit
     FOR UPDATE OF i SKIP LOCKED
  ), upd AS (
    UPDATE rfq_invitations i
       SET delivery_state = 'sending',
           delivery_attempts = i.delivery_attempts + 1,
           last_attempt_at = now(),
           updated_at = now()
      FROM claimed c
     WHERE i.id = c.id
     RETURNING i.*
  )
  SELECT u.id, u.supplier_id,
         COALESCE(u.contact_email, ct.email),
         r.rfq_number, r.business_id, r.organization_id,
         u.response_deadline, u.delivery_attempts
    FROM upd u
    JOIN rfqs r ON r.id = u.rfq_id
    LEFT JOIN contacts ct ON ct.id = u.supplier_id;
END;
$$;

-- 4. Worker: record the outcome of one delivery attempt.
CREATE OR REPLACE FUNCTION public.rfq_invitation_record_delivery(
  _invitation_id uuid, _state text, _error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _state NOT IN ('sent', 'delivered', 'failed') THEN
    RAISE EXCEPTION 'Invalid delivery state %', _state;
  END IF;
  UPDATE rfq_invitations
     SET delivery_state = _state,
         delivery_error = CASE WHEN _state = 'failed' THEN _error ELSE NULL END,
         sent_at = CASE WHEN _state IN ('sent','delivered') THEN COALESCE(sent_at, now()) ELSE sent_at END,
         delivered_at = CASE WHEN _state = 'delivered' THEN now() ELSE delivered_at END,
         invitation_state = CASE WHEN _state IN ('sent','delivered') AND invitation_state = 'pending'
                                 THEN 'invited' ELSE invitation_state END,
         updated_at = now()
   WHERE id = _invitation_id;
END;
$$;

-- 5. User action: requeue one invitation for delivery.
CREATE OR REPLACE FUNCTION public.rfq_invitation_resend(_invitation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rfq public.rfqs; v_inv public.rfq_invitations;
BEGIN
  SELECT * INTO v_inv FROM rfq_invitations WHERE id = _invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  SELECT * INTO v_rfq FROM rfqs WHERE id = v_inv.rfq_id;
  IF NOT user_can_access_business(auth.uid(), v_rfq.business_id) THEN
    RAISE EXCEPTION 'Not authorised for this business';
  END IF;
  IF v_rfq.status NOT IN ('sent', 'responses_received', 'under_evaluation') THEN
    RAISE EXCEPTION 'RFQ % is % — invitations can only be resent while sourcing is open', v_rfq.rfq_number, v_rfq.status;
  END IF;
  IF v_inv.rfq_version <> v_rfq.version THEN
    RAISE EXCEPTION 'Invitation belongs to superseded RFQ version %', v_inv.rfq_version;
  END IF;

  UPDATE rfq_invitations
     SET delivery_state = 'queued', delivery_error = NULL, delivery_attempts = 0,
         reminder_count = reminder_count + CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END,
         last_reminder_at = CASE WHEN sent_at IS NOT NULL THEN now() ELSE last_reminder_at END,
         updated_at = now()
   WHERE id = _invitation_id;

  PERFORM _rfq_emit(v_rfq, 'rfq.supplier_invitation_requested',
    jsonb_build_object('invitations', 1, 'resend', true, 'invitation_id', _invitation_id,
                       'nonce', gen_random_uuid()), auth.uid());
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 6. Scheduled expiry sweep — no signed-in user, all businesses.
CREATE OR REPLACE FUNCTION public.rfq_expire_due_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int; r record;
BEGIN
  UPDATE rfqs SET status = 'expired', updated_at = now()
   WHERE status IN ('sent','responses_received','under_evaluation')
     AND expires_at IS NOT NULL AND expires_at < now()
     AND NOT EXISTS (SELECT 1 FROM rfq_awards a WHERE a.rfq_id = rfqs.id);
  GET DIAGNOSTICS n = ROW_COUNT;

  FOR r IN SELECT * FROM rfqs
            WHERE status = 'expired' AND updated_at > now() - interval '1 minute'
  LOOP
    PERFORM _rfq_emit(r, 'rfq.expired', jsonb_build_object('expired_at', now()), NULL);
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.rfq_invitations_claim_for_delivery(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfq_invitation_record_delivery(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rfq_expire_due_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_invitations_claim_for_delivery(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfq_invitation_record_delivery(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rfq_expire_due_all() TO service_role;
GRANT EXECUTE ON FUNCTION public.rfq_invitation_resend(uuid) TO authenticated;
