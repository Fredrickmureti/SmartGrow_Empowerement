CREATE OR REPLACE FUNCTION public.delete_credit_note_atomic(_credit_note_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cn RECORD;
  v_movements integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;
  IF _credit_note_id IS NULL THEN
    RAISE EXCEPTION 'credit_note_id is required';
  END IF;

  SELECT * INTO v_cn FROM public.credit_notes WHERE id = _credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note not found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_cn.business_id) THEN
    RAISE EXCEPTION 'Access denied for this credit note' USING ERRCODE = '42501';
  END IF;

  IF v_cn.status <> 'draft'::credit_note_status THEN
    RAISE EXCEPTION 'Only draft credit notes can be deleted (this one is %). Void it instead.', v_cn.status;
  END IF;
  IF COALESCE(v_cn.amount_applied, 0) > 0 THEN
    RAISE EXCEPTION 'This credit note has been applied. Void it instead.';
  END IF;
  IF COALESCE(v_cn.refund_amount, 0) > 0 THEN
    RAISE EXCEPTION 'This credit note has refunds recorded. Void it instead.';
  END IF;

  -- The credit ledger is the authority (ADR 0131), not the header columns.
  SELECT count(*) INTO v_movements
  FROM public.customer_credit_movements m
  WHERE m.credit_note_id = _credit_note_id;
  IF v_movements > 0 THEN
    RAISE EXCEPTION 'This credit note already has customer credit movements. Void it instead.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.journal_entries je
              WHERE je.source_type = 'credit_note' AND je.source_id = _credit_note_id) THEN
    RAISE EXCEPTION 'This credit note is posted to the general ledger. Void it instead.';
  END IF;

  DELETE FROM public.credit_note_items WHERE credit_note_id = _credit_note_id;
  DELETE FROM public.credit_notes WHERE id = _credit_note_id;

  RETURN jsonb_build_object('credit_note_id', _credit_note_id, 'deleted', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_credit_note_atomic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_credit_note_atomic(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';