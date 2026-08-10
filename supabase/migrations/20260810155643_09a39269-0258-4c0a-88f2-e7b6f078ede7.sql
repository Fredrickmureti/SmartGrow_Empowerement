CREATE OR REPLACE FUNCTION public.approve_bill_atomic(_bill_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill RECORD;
  v_block boolean;
  v_exception text;
BEGIN
  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status = 'approved'::bill_status THEN
    RETURN jsonb_build_object('success', true, 'status', 'approved', 'already', true);
  END IF;
  IF v_bill.status NOT IN ('draft'::bill_status, 'submitted'::bill_status) THEN
    RAISE EXCEPTION 'Only draft or submitted bills can be approved (bill % is %)', v_bill.bill_number, v_bill.status;
  END IF;

  IF _actor IS NOT NULL AND v_bill.created_by IS NOT NULL AND _actor = v_bill.created_by THEN
    RAISE EXCEPTION 'Segregation of duties: the person who entered bill % cannot approve it.', v_bill.bill_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(b.block_bill_approval_on_match_exception, true)
    INTO v_block FROM public.businesses b WHERE b.id = v_bill.business_id;

  IF COALESCE(v_block, true) THEN
    SELECT r.match_state::text INTO v_exception
      FROM public.bill_match_results r
     WHERE r.bill_id = _bill_id
       AND r.exception_state = 'pending_review'::bill_match_exception_state
     ORDER BY r.matched_at DESC NULLS LAST
     LIMIT 1;

    IF v_exception IS NOT NULL THEN
      RAISE EXCEPTION
        'Bill % has an unresolved match discrepancy (%). Resolve the exception before approving.',
        v_bill.bill_number, v_exception
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE public.bills
     SET status = 'approved'::bill_status, updated_at = now()
   WHERE id = _bill_id;

  RETURN jsonb_build_object('success', true, 'status', 'approved', 'bill_number', v_bill.bill_number);
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_bill_atomic(uuid, uuid) TO authenticated;