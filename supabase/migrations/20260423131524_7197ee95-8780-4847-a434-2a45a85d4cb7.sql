
-- =====================================================================
-- MIGRATION 2: Atomic RPCs
-- =====================================================================

-- ---------------------------------------------------------------------
-- apply_vendor_credit_atomic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_vendor_credit_atomic(
  p_vcn_id uuid,
  p_bill_id uuid,
  p_amount numeric,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_vcn   RECORD;
  v_bill  RECORD;
  v_remaining_credit numeric;
  v_remaining_bill   numeric;
  v_new_paid numeric;
  v_new_status text;
  v_app_id uuid;
  v_payment_id uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be positive');
  END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, total,
         COALESCE(amount_applied, 0) AS amount_applied, status,
         credit_note_number, currency
    INTO v_vcn
    FROM vendor_credit_notes
   WHERE id = p_vcn_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vendor credit note not found');
  END IF;

  SELECT id, organization_id, business_id, branch_id, vendor_id, total,
         COALESCE(amount_paid, 0) AS amount_paid, status, currency
    INTO v_bill
    FROM bills
   WHERE id = p_bill_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Bill not found');
  END IF;

  IF v_vcn.organization_id <> v_bill.organization_id
     OR v_vcn.business_id <> v_bill.business_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'VCN and bill belong to different companies');
  END IF;

  IF v_vcn.vendor_id IS DISTINCT FROM v_bill.vendor_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'VCN vendor does not match bill vendor');
  END IF;

  v_remaining_credit := v_vcn.total - v_vcn.amount_applied;
  v_remaining_bill   := v_bill.total - v_bill.amount_paid;

  IF p_amount > v_remaining_credit + 0.001 THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Amount exceeds remaining credit balance', 'remaining_credit', v_remaining_credit);
  END IF;
  IF p_amount > v_remaining_bill + 0.001 THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Amount exceeds remaining bill balance', 'remaining_bill', v_remaining_bill);
  END IF;

  v_new_paid   := v_bill.amount_paid + p_amount;
  v_new_status := CASE WHEN v_new_paid >= v_bill.total - 0.001 THEN 'paid' ELSE 'partial' END;

  -- 1) bill payment ledger entry (no GL — VCN already posted DR AP)
  INSERT INTO bill_payments (
    organization_id, business_id, branch_id, bill_id, payment_date,
    amount, payment_method, reference, notes, created_by
  ) VALUES (
    v_bill.organization_id, v_bill.business_id, v_bill.branch_id, v_bill.id, CURRENT_DATE,
    p_amount, 'vendor_credit',
    'VCN ' || COALESCE(v_vcn.credit_note_number, v_vcn.id::text),
    'Vendor credit applied', p_user_id
  ) RETURNING id INTO v_payment_id;

  -- 2) application junction
  INSERT INTO vendor_credit_note_applications (
    organization_id, business_id, credit_note_id, bill_id, amount, applied_by
  ) VALUES (
    v_vcn.organization_id, v_vcn.business_id, v_vcn.id, v_bill.id, p_amount, p_user_id
  ) RETURNING id INTO v_app_id;

  -- 3) update bill
  UPDATE bills
     SET amount_paid = v_new_paid,
         status      = v_new_status::bill_status,
         updated_at  = now()
   WHERE id = v_bill.id;

  -- 4) update VCN amount_applied + status
  UPDATE vendor_credit_notes
     SET amount_applied = amount_applied + p_amount,
         status = CASE
           WHEN amount_applied + p_amount >= total - 0.001 THEN 'applied'
           ELSE 'partial'
         END,
         updated_at = now()
   WHERE id = v_vcn.id;

  RETURN jsonb_build_object(
    'success', true,
    'application_id', v_app_id,
    'bill_payment_id', v_payment_id,
    'new_amount_paid', v_new_paid,
    'new_bill_status', v_new_status
  );
END$fn$;

-- ---------------------------------------------------------------------
-- mark_po_billed — server-side PO→Bill linkage
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_po_billed(
  p_po_id uuid,
  p_bill_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_po   RECORD;
  v_bill RECORD;
BEGIN
  SELECT id, organization_id, business_id, billing_status, converted_bill_id
    INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchase order not found');
  END IF;

  SELECT id, organization_id, business_id
    INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Bill not found');
  END IF;

  IF v_po.organization_id <> v_bill.organization_id
     OR v_po.business_id <> v_bill.business_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'PO and bill belong to different companies');
  END IF;

  UPDATE purchase_order_items
     SET quantity_billed = quantity
   WHERE purchase_order_id = p_po_id;

  UPDATE purchase_orders
     SET converted_bill_id = p_bill_id,
         billing_status    = 'fully_billed',
         updated_at        = now()
   WHERE id = p_po_id;

  RETURN jsonb_build_object('success', true, 'po_id', p_po_id, 'bill_id', p_bill_id);
END$fn$;

-- ---------------------------------------------------------------------
-- get_ap_aging_summary
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL,
  p_as_of date DEFAULT CURRENT_DATE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $fn$
DECLARE v_result jsonb;
BEGIN
  WITH open_bills AS (
    SELECT
      b.id,
      b.vendor_id,
      b.due_date,
      (b.total - COALESCE(b.amount_paid, 0))::numeric AS balance
    FROM bills b
    WHERE b.organization_id = p_organization_id
      AND b.business_id     = p_business_id
      AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)
      AND b.status::text NOT IN ('draft','void','paid','cancelled')
      AND b.bill_date <= p_as_of
      AND (b.total - COALESCE(b.amount_paid, 0)) > 0.001
  ), bucketed AS (
    SELECT
      CASE
        WHEN due_date >= p_as_of                              THEN 'current'
        WHEN p_as_of - due_date BETWEEN 1  AND 30             THEN 'd1_30'
        WHEN p_as_of - due_date BETWEEN 31 AND 60             THEN 'd31_60'
        WHEN p_as_of - due_date BETWEEN 61 AND 90             THEN 'd61_90'
        ELSE 'd90_plus'
      END AS bucket,
      balance
    FROM open_bills
  )
  SELECT jsonb_build_object(
    'as_of',     p_as_of,
    'current',   COALESCE(SUM(balance) FILTER (WHERE bucket='current'),  0),
    'd1_30',     COALESCE(SUM(balance) FILTER (WHERE bucket='d1_30'),    0),
    'd31_60',    COALESCE(SUM(balance) FILTER (WHERE bucket='d31_60'),   0),
    'd61_90',    COALESCE(SUM(balance) FILTER (WHERE bucket='d61_90'),   0),
    'd90_plus',  COALESCE(SUM(balance) FILTER (WHERE bucket='d90_plus'), 0),
    'total',     COALESCE(SUM(balance), 0),
    'open_count',(SELECT COUNT(*) FROM open_bills)
  ) INTO v_result
  FROM bucketed;

  RETURN v_result;
END$fn$;

-- ---------------------------------------------------------------------
-- get_top_vendor_spend
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_top_vendor_spend(
  p_organization_id uuid,
  p_business_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid DEFAULT NULL,
  p_limit int DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $fn$
DECLARE v_result jsonb;
BEGIN
  WITH spend AS (
    SELECT
      b.vendor_id,
      SUM(b.total)::numeric AS total_spent,
      COUNT(*)::int          AS bill_count
    FROM bills b
    WHERE b.organization_id = p_organization_id
      AND b.business_id     = p_business_id
      AND (p_branch_id IS NULL OR b.branch_id = p_branch_id)
      AND b.status::text NOT IN ('draft','void','cancelled')
      AND b.bill_date BETWEEN p_from AND p_to
    GROUP BY b.vendor_id
    ORDER BY total_spent DESC
    LIMIT p_limit
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vendor_id',   s.vendor_id,
    'vendor_name', c.name,
    'total_spent', s.total_spent,
    'bill_count',  s.bill_count
  ) ORDER BY s.total_spent DESC), '[]'::jsonb)
  INTO v_result
  FROM spend s
  LEFT JOIN contacts c ON c.id = s.vendor_id;

  RETURN v_result;
END$fn$;
