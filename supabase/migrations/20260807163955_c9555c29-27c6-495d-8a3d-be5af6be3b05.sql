CREATE OR REPLACE FUNCTION public.create_credit_note_atomic(jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payload alias for $1;
BEGIN
  IF v_payload IS NULL OR jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION 'Credit note request must be a JSON object';
  END IF;

  RETURN public.create_credit_note_atomic(
    NULLIF(v_payload->>'_org_id', '')::uuid,
    NULLIF(v_payload->>'_business_id', '')::uuid,
    NULLIF(v_payload->>'_branch_id', '')::uuid,
    NULLIF(v_payload->>'_contact_id', '')::uuid,
    NULLIF(v_payload->>'_invoice_id', '')::uuid,
    NULLIF(v_payload->>'_issue_date', '')::date,
    NULLIF(v_payload->>'_reason', ''),
    NULLIF(v_payload->>'_notes', ''),
    v_payload->'_items',
    NULLIF(v_payload->>'_source_return_id', '')::uuid,
    COALESCE((v_payload->>'_issue')::boolean, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_credit_note_atomic(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credit_note_atomic(jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';