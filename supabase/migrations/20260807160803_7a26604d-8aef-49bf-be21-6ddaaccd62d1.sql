-- ADR 0132 — server-side FIFO allocation for vendor credit, mirroring the
-- AR side. The browser must never choose which bills a credit lands on.
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_fifo_atomic(
  _org_id uuid,
  _business_id uuid,
  _vendor_credit_note_id uuid,
  _bill_ids uuid[] DEFAULT NULL,
  _applied_by uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vcn         record;
  v_available   numeric;
  v_bill        record;
  v_amount      numeric;
  v_total       numeric := 0;
  v_allocs      jsonb := '[]'::jsonb;
  v_res         jsonb;
BEGIN
  SELECT * INTO v_vcn
    FROM public.vendor_credit_notes
   WHERE id = _vendor_credit_note_id
     AND business_id = _business_id
   FOR UPDATE;
  IF v_vcn IS NULL THEN
    RAISE EXCEPTION 'Vendor credit note % not found in this company', _vendor_credit_note_id
      USING ERRCODE = '22023';
  END IF;

  -- Availability comes from the credit ledger, never from document columns.
  SELECT COALESCE(b.balance, 0) INTO v_available
    FROM public.vendor_credit_balances b
   WHERE b.id = public.vendor_credit_balance_id(
                  _org_id, _business_id, v_vcn.vendor_id,
                  COALESCE(v_vcn.currency, 'USD'));
  v_available := COALESCE(v_available, 0);

  IF v_available <= 0 THEN
    RETURN jsonb_build_object('success', true, 'total_applied', 0,
                              'credit_remaining', 0, 'allocations', v_allocs);
  END IF;

  FOR v_bill IN
    SELECT bl.id,
           GREATEST(COALESCE(bl.total, 0) - COALESCE(bl.amount_paid, 0), 0) AS open_amount
      FROM public.bills bl
     WHERE bl.business_id = _business_id
       AND bl.vendor_id = v_vcn.vendor_id
       AND COALESCE(bl.currency, 'USD') = COALESCE(v_vcn.currency, 'USD')
       AND bl.status NOT IN ('draft', 'cancelled', 'void', 'paid')
       AND (_bill_ids IS NULL OR bl.id = ANY(_bill_ids))
       AND GREATEST(COALESCE(bl.total, 0) - COALESCE(bl.amount_paid, 0), 0) > 0
     ORDER BY bl.due_date NULLS LAST, bl.created_at, bl.id
  LOOP
    EXIT WHEN v_available <= 0;
    v_amount := LEAST(v_available, v_bill.open_amount);
    CONTINUE WHEN v_amount <= 0;

    v_res := public.apply_vendor_credit_to_bill_atomic(
      _org_id, _business_id, _vendor_credit_note_id, v_bill.id, v_amount,
      _applied_by, NULL, _branch_id);

    v_available := v_available - v_amount;
    v_total := v_total + v_amount;
    v_allocs := v_allocs || jsonb_build_object('bill_id', v_bill.id, 'amount', v_amount);
  END LOOP;

  RETURN jsonb_build_object('success', true,
                            'total_applied', v_total,
                            'credit_remaining', v_available,
                            'allocations', v_allocs);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_vendor_credit_fifo_atomic(uuid,uuid,uuid,uuid[],uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_vendor_credit_fifo_atomic(uuid,uuid,uuid,uuid[],uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_vendor_credit_fifo_atomic(uuid,uuid,uuid,uuid[],uuid,uuid) TO service_role;