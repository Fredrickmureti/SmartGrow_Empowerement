-- 1. Approval gate: booking a bill straight from draft is refused when the company requires approval
CREATE OR REPLACE FUNCTION public.enforce_bill_approval_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_require boolean;
BEGIN
  IF NEW.status <> 'received'::bill_status OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(b.require_bill_approval, false)
    INTO v_require
    FROM public.businesses b
   WHERE b.id = NEW.business_id;

  IF COALESCE(v_require, false)
     AND OLD.status NOT IN ('approved'::bill_status, 'partial'::bill_status, 'paid'::bill_status) THEN
    RAISE EXCEPTION
      'Bill % must be approved before it can be booked (company policy requires bill approval).', NEW.bill_number
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bills_approval_gate ON public.bills;
CREATE TRIGGER trg_bills_approval_gate
  BEFORE UPDATE OF status ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bill_approval_gate();

-- 2. Submit for approval
CREATE OR REPLACE FUNCTION public.submit_bill_atomic(_bill_id uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_bill RECORD;
BEGIN
  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status = 'submitted'::bill_status THEN
    RETURN jsonb_build_object('success', true, 'status', 'submitted', 'already', true);
  END IF;
  IF v_bill.status <> 'draft'::bill_status THEN
    RAISE EXCEPTION 'Only draft bills can be submitted for approval (bill % is %)', v_bill.bill_number, v_bill.status;
  END IF;

  UPDATE public.bills
     SET status = 'submitted'::bill_status, updated_at = now()
   WHERE id = _bill_id;

  RETURN jsonb_build_object('success', true, 'status', 'submitted', 'bill_number', v_bill.bill_number);
END;
$$;

-- 3. Approve (segregation of duties + match-exception gate)
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
    SELECT r.reason INTO v_exception
      FROM public.bill_match_results r
     WHERE r.bill_id = _bill_id
       AND r.exception_state = 'pending_review'
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'Bill % has an unresolved match discrepancy (%). Resolve the exception before approving.',
        v_bill.bill_number, COALESCE(v_exception, 'pending review')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE public.bills
     SET status = 'approved'::bill_status, updated_at = now()
   WHERE id = _bill_id;

  RETURN jsonb_build_object('success', true, 'status', 'approved', 'bill_number', v_bill.bill_number);
END;
$$;

-- 4. Reject back to draft
CREATE OR REPLACE FUNCTION public.reject_bill_atomic(_bill_id uuid, _reason text, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_bill RECORD;
BEGIN
  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF v_bill.status NOT IN ('submitted'::bill_status, 'approved'::bill_status) THEN
    RAISE EXCEPTION 'Only submitted or approved bills can be rejected (bill % is %)', v_bill.bill_number, v_bill.status;
  END IF;

  UPDATE public.bills
     SET status = 'draft'::bill_status,
         notes = COALESCE(notes || E'\n', '') || 'Rejected: ' || COALESCE(_reason, 'no reason given'),
         updated_at = now()
   WHERE id = _bill_id;

  RETURN jsonb_build_object('success', true, 'status', 'draft', 'bill_number', v_bill.bill_number);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_bill_atomic(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_bill_atomic(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_bill_atomic(uuid, text, uuid) TO authenticated;

-- 5. Receipt-aware PO -> bill conversion
CREATE OR REPLACE FUNCTION public.convert_po_to_bill_atomic(_po_id uuid, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po RECORD; v_bill_id uuid; v_bill_no text; v_attempts int := 0; v_max int := 20;
  v_company_ccy text; v_rate numeric := 1; v_company_total numeric;
  v_billing text; v_any_under boolean; v_any_billed boolean;
  v_subtotal numeric := 0; v_tax numeric := 0; v_total numeric := 0;
  v_billable int := 0;
BEGIN
  SELECT id, organization_id, business_id, branch_id, vendor_id, po_number,
         currency, notes, status, billing_status, converted_bill_id
    INTO v_po FROM public.purchase_orders WHERE id = _po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  -- Bill only what has been received and is not yet billed (three-way match).
  DROP TABLE IF EXISTS _billable_lines;
  CREATE TEMP TABLE _billable_lines ON COMMIT DROP AS
  SELECT poi.id AS po_item_id,
         poi.product_id,
         poi.description,
         LEAST(
           GREATEST(COALESCE(poi.quantity_received, 0) - COALESCE(poi.quantity_billed, 0), 0),
           GREATEST(COALESCE(poi.quantity, 0) - COALESCE(poi.quantity_billed, 0), 0)
         ) AS qty,
         COALESCE(poi.unit_price, 0) AS unit_price,
         COALESCE(poi.tax_rate, 0) AS tax_rate,
         COALESCE(poi.sort_order, 0) AS sort_order
    FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = v_po.id;

  DELETE FROM _billable_lines WHERE qty <= 0;
  SELECT COUNT(*) INTO v_billable FROM _billable_lines;

  IF v_billable = 0 THEN
    RAISE EXCEPTION
      'Nothing to bill on purchase order %: no received quantity is awaiting an invoice. Receive the goods first.',
      v_po.po_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(ROUND(qty * unit_price, 2)), 0),
         COALESCE(SUM(ROUND(qty * unit_price * tax_rate / 100.0, 2)), 0)
    INTO v_subtotal, v_tax FROM _billable_lines;
  v_total := v_subtotal + v_tax;

  SELECT base_currency INTO v_company_ccy FROM public.businesses WHERE id = v_po.business_id;
  IF v_po.currency IS NOT NULL AND v_company_ccy IS NOT NULL AND v_po.currency <> v_company_ccy THEN
    SELECT rate INTO v_rate FROM public.exchange_rates
     WHERE organization_id = v_po.organization_id
       AND from_currency = v_po.currency AND to_currency = v_company_ccy
       AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC LIMIT 1;
    v_rate := COALESCE(v_rate, 1);
  END IF;
  v_company_total := ROUND(v_total * v_rate, 2);

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > v_max THEN RAISE EXCEPTION 'Unable to allocate bill number after % attempts', v_max; END IF;
    v_bill_no := public.get_next_bill_number(v_po.organization_id);
    BEGIN
      INSERT INTO public.bills (organization_id, business_id, branch_id, vendor_id,
        bill_number, status, bill_date, due_date, subtotal, tax_amount,
        discount_amount, total, currency, currency_rate, company_currency_total,
        notes, created_by, source_purchase_order_id)
      VALUES (v_po.organization_id, v_po.business_id, v_po.branch_id, v_po.vendor_id,
        v_bill_no, 'draft'::bill_status, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        v_subtotal, v_tax, 0, v_total,
        v_po.currency, v_rate, v_company_total, v_po.notes, _user_id, v_po.id)
      RETURNING id INTO v_bill_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;

  -- The sync_po_line_billed_quantities trigger recomputes quantity_billed and
  -- PO billing_status from these lines, and blocks any over-billing.
  INSERT INTO public.bill_items (bill_id, product_id, purchase_order_item_id,
    description, quantity, unit_price, tax_rate, tax_amount, line_total, sort_order)
  SELECT v_bill_id, l.product_id, l.po_item_id, l.description, l.qty, l.unit_price,
         l.tax_rate,
         ROUND(l.qty * l.unit_price * l.tax_rate / 100.0, 2),
         ROUND(l.qty * l.unit_price, 2),
         l.sort_order
    FROM _billable_lines l;

  SELECT BOOL_OR(COALESCE(quantity_billed,0) < COALESCE(quantity,0)),
         BOOL_OR(COALESCE(quantity_billed,0) > 0)
    INTO v_any_under, v_any_billed
    FROM public.purchase_order_items WHERE purchase_order_id = v_po.id;

  v_billing := CASE
    WHEN v_any_under IS NOT TRUE THEN 'fully_billed'
    WHEN v_any_billed THEN 'to_bill'
    ELSE 'no'
  END;

  -- converted_bill_id only latches once the PO is fully billed, so a PO can be
  -- billed in instalments as goods arrive.
  UPDATE public.purchase_orders
     SET converted_bill_id = CASE WHEN v_billing = 'fully_billed' THEN v_bill_id ELSE converted_bill_id END,
         billing_status = v_billing,
         updated_at = now()
   WHERE id = v_po.id;

  RETURN jsonb_build_object('success', true, 'bill_id', v_bill_id, 'bill_number', v_bill_no,
    'billing_status', v_billing, 'lines_billed', v_billable,
    'currency_rate', v_rate, 'company_currency_total', v_company_total);
END;
$$;

-- 6. Payables summary: pre-posting review states are not "unposted liabilities"
DROP FUNCTION IF EXISTS public.get_ap_summary(uuid, uuid, uuid, date);
CREATE FUNCTION public.get_ap_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  open_document_count integer,
  total_residual numeric,
  not_due numeric,
  current_bucket numeric,
  days30 numeric,
  days60 numeric,
  days90 numeric,
  overdue_count integer,
  unposted_document_count integer,
  unposted_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH open_items AS (
    SELECT o.*,
           GREATEST(0, (_as_of - COALESCE(o.due_date, o.document_date)))::int AS days_past_due
      FROM public.finance_ap_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(b.total,0) - COALESCE(b.amount_paid,0))), 0) AS amt
      FROM public.bills b
     WHERE b.organization_id = _org_id
       AND (_business_id IS NULL OR b.business_id = _business_id)
       AND (_branch_id IS NULL OR b.branch_id = _branch_id)
       AND b.status::text NOT IN ('draft', 'submitted', 'approved', 'cancelled', 'voided', 'void', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'bill'
            AND je.source_id = b.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE COALESCE(due_date, document_date) > _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 0 AND 30 AND COALESCE(due_date, document_date) <= _as_of),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 31 AND 60),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due BETWEEN 61 AND 90),
    (SELECT COALESCE(SUM(residual_amount), 0) FROM open_items WHERE days_past_due > 90),
    (SELECT COUNT(*)::int FROM open_items WHERE COALESCE(due_date, document_date) < _as_of),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted)
$$;

GRANT EXECUTE ON FUNCTION public.get_ap_summary(uuid, uuid, uuid, date) TO authenticated;