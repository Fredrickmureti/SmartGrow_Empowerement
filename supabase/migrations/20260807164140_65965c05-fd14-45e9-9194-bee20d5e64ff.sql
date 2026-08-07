CREATE OR REPLACE FUNCTION public.create_credit_note_request_atomic(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _payload IS NULL OR jsonb_typeof(_payload) <> 'object' THEN
    RAISE EXCEPTION 'Credit note request must be a JSON object';
  END IF;

  RETURN public.create_credit_note_atomic(
    NULLIF(_payload->>'_org_id', '')::uuid,
    NULLIF(_payload->>'_business_id', '')::uuid,
    NULLIF(_payload->>'_branch_id', '')::uuid,
    NULLIF(_payload->>'_contact_id', '')::uuid,
    NULLIF(_payload->>'_invoice_id', '')::uuid,
    NULLIF(_payload->>'_issue_date', '')::date,
    NULLIF(_payload->>'_reason', ''),
    NULLIF(_payload->>'_notes', ''),
    _payload->'_items',
    NULLIF(_payload->>'_source_return_id', '')::uuid,
    COALESCE((_payload->>'_issue')::boolean, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_credit_note_request_atomic(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_request_atomic(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';