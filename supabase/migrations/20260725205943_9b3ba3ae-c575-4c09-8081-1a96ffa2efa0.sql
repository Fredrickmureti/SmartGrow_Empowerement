CREATE OR REPLACE FUNCTION public.loan_log_event(_loan_id uuid, _event_type text, _prior_status text, _new_status text, _amount numeric DEFAULT NULL::numeric, _reason text DEFAULT NULL::text, _payload jsonb DEFAULT '{}'::jsonb, _cosigner uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org      uuid;
  _biz      uuid;
  _branch   uuid;
  _id       uuid;
  _payload2 jsonb;
BEGIN
  SELECT organization_id, business_id
    INTO _org, _biz
    FROM public.employee_loans WHERE id = _loan_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'loan not found: %', _loan_id; END IF;

  _branch := NULL;

  INSERT INTO public.loan_lifecycle_events(
    organization_id, loan_id, event_type, prior_status, new_status,
    amount, reason, payload, actor_user_id, cosigner_user_id
  ) VALUES (
    _org, _loan_id, _event_type, _prior_status, _new_status,
    _amount, _reason, COALESCE(_payload, '{}'::jsonb),
    auth.uid(), _cosigner
  ) RETURNING id INTO _id;

  BEGIN
    _payload2 := COALESCE(_payload, '{}'::jsonb)
              || jsonb_build_object(
                   'loan_id',       _loan_id,
                   'prior_status',  _prior_status,
                   'new_status',    _new_status,
                   'amount',        _amount,
                   'reason',        _reason,
                   'cosigner',      _cosigner,
                   'event_id',      _id
                 );
    INSERT INTO public.business_event_outbox(
      org_id, branch_id, event_type, source_doc_type, source_doc_id,
      payload, status, actor_user_id, idempotency_key, source
    ) VALUES (
      _biz, _branch, 'loan.' || _event_type, 'employee_loan', _loan_id,
      _payload2, 'pending', auth.uid(),
      'loan:' || _loan_id::text || ':' || _id::text,
      'employee_loan_lifecycle'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'loan_log_event outbox emit failed for loan % event %: %',
      _loan_id, _event_type, SQLERRM;
  END;

  RETURN _id;
END $function$;