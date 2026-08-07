ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS credit_note_prefix text DEFAULT 'CN-';

DROP FUNCTION IF EXISTS public.get_next_credit_note_number(uuid);

CREATE OR REPLACE FUNCTION public.get_next_credit_note_number(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  next_num integer;
  prefix text;
BEGIN
  IF _business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for credit note numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('credit_notes_' || _business_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN credit_note_number ~ '\d+$'
      THEN CAST(substring(credit_note_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.credit_notes
  WHERE organization_id = _org_id
    AND business_id = _business_id;

  SELECT COALESCE(NULLIF(b.credit_note_prefix, ''), 'CN-')
    INTO prefix
  FROM public.businesses b
  WHERE b.id = _business_id;

  prefix := COALESCE(prefix, 'CN-');

  RETURN prefix || LPAD(next_num::text, 5, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_next_vendor_credit_note_number(p_organization_id uuid, p_business_id uuid DEFAULT NULL::uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_next_num integer;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for vendor credit note numbering (multi-company isolation)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('vendor_credit_notes_' || p_business_id::text));

  SELECT COALESCE(MAX(
    CASE WHEN credit_note_number ~ '\d+$'
      THEN CAST(substring(credit_note_number FROM '\d+$') AS integer)
      ELSE 0
    END
  ), 0) + 1
  INTO v_next_num
  FROM public.vendor_credit_notes
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id;

  RETURN 'VCN-' || LPAD(v_next_num::text, 5, '0');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_next_credit_note_number(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_vendor_credit_note_number(uuid, uuid) TO authenticated;