-- Phase 4c completion — a bill void must leave the purchase order billable
-- again. `sync_po_line_billed_quantities` only fires on `bill_items` DML, and
-- `mark_po_billed` blunt-sets `quantity_billed = quantity` /
-- `billing_status = 'fully_billed'`, so voiding a bill (which touches only
-- `bills`) left the PO falsely fully billed with no way to re-bill it.

CREATE OR REPLACE FUNCTION public.po_resync_billed_state(_po_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total            int;
  v_fully            int;
  v_partial          int;
  v_status           text;
BEGIN
  IF _po_id IS NULL THEN
    RETURN;
  END IF;

  -- Recompute every line from the bills that still count (void bills do not).
  UPDATE public.purchase_order_items poi
     SET quantity_billed = COALESCE(agg.qty, 0)
    FROM (
      SELECT poi2.id AS poi_id,
             COALESCE(SUM(bi.quantity), 0) AS qty
        FROM public.purchase_order_items poi2
        LEFT JOIN public.bill_items bi ON bi.purchase_order_item_id = poi2.id
        LEFT JOIN public.bills b ON b.id = bi.bill_id
       WHERE poi2.purchase_order_id = _po_id
         AND (b.id IS NULL OR b.status::text <> 'void')
       GROUP BY poi2.id
    ) agg
   WHERE poi.id = agg.poi_id;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE COALESCE(quantity_billed, 0) >= quantity),
         COUNT(*) FILTER (WHERE COALESCE(quantity_billed, 0) > 0
                            AND COALESCE(quantity_billed, 0) < quantity)
    INTO v_total, v_fully, v_partial
    FROM public.purchase_order_items
   WHERE purchase_order_id = _po_id;

  v_status := CASE
    WHEN v_total = 0 THEN 'no'
    WHEN v_fully = v_total THEN 'fully_billed'
    WHEN v_fully > 0 OR v_partial > 0 THEN 'to_bill'
    ELSE 'no'
  END;

  UPDATE public.purchase_orders
     SET billing_status = v_status,
         updated_at     = now()
   WHERE id = _po_id;
END;
$function$;

COMMENT ON FUNCTION public.po_resync_billed_state(uuid) IS
  'Canonical recompute of purchase_order_items.quantity_billed and purchase_orders.billing_status from non-void bills. Used by the bill reversal path so a voided bill leaves its PO billable again.';

CREATE OR REPLACE FUNCTION public.po_resync_billed_state_for_bill(_bill_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_po_id uuid;
BEGIN
  IF _bill_id IS NULL THEN
    RETURN;
  END IF;

  -- A PO whose conversion pointer names this bill must release the pointer, or
  -- the UI keeps offering the voided bill as the PO's bill.
  UPDATE public.purchase_orders
     SET converted_bill_id = NULL,
         updated_at        = now()
   WHERE converted_bill_id = _bill_id;

  FOR v_po_id IN
    SELECT DISTINCT poi.purchase_order_id
      FROM public.bill_items bi
      JOIN public.purchase_order_items poi ON poi.id = bi.purchase_order_item_id
     WHERE bi.bill_id = _bill_id
       AND poi.purchase_order_id IS NOT NULL
    UNION
    SELECT po.id
      FROM public.purchase_orders po
     WHERE po.id = (SELECT purchase_order_id FROM public.bills WHERE id = _bill_id)
  LOOP
    PERFORM public.po_resync_billed_state(v_po_id);
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.po_resync_billed_state_for_bill(uuid) IS
  'Restores purchase-order billing state after a bill is voided (ADR 0128 sibling: reversal must compensate every subsystem the forward posting touched).';

-- Re-declare the canonical bill void writer with the purchase-order
-- restoration step added after the status flip (the recompute filters on
-- bills.status <> ''void'', so it must run once the bill is already void).
CREATE OR REPLACE FUNCTION public.void_bill_atomic(_bill_id uuid, _reason text, _void_date date DEFAULT NULL::date, _actor uuid DEFAULT NULL::uuid, _client_request_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bill        public.bills%ROWTYPE;
  v_date        date := COALESCE(_void_date, CURRENT_DATE);
  v_live_pay    int := 0;
  v_je          RECORD;
  v_rev         uuid;
  v_reversals   uuid[] := ARRAY[]::uuid[];
BEGIN
  IF _bill_id IS NULL THEN
    RAISE EXCEPTION 'void_bill_atomic requires a bill id' USING ERRCODE = '22023';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to void a bill.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = _bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill % not found.', _bill_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_belongs_to_org(v_bill.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  -- idempotent
  IF v_bill.status::text = 'void' THEN
    RETURN jsonb_build_object(
      'result', 'already_voided',
      'bill_id', _bill_id,
      'bill_number', v_bill.bill_number);
  END IF;

  IF v_bill.status::text = 'draft' THEN
    RAISE EXCEPTION 'Bill % is still a draft — nothing was posted. Delete or edit the draft instead of voiding it.',
      COALESCE(v_bill.bill_number, _bill_id::text) USING ERRCODE = '23514';
  END IF;

  SELECT count(DISTINCT bp.id) INTO v_live_pay
    FROM public.bill_payment_allocations a
    JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
   WHERE a.bill_id = _bill_id
     AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');

  IF v_live_pay > 0 THEN
    RAISE EXCEPTION
      'Bill % is settled by % supplier payment(s). Void the payment(s) first, or raise a vendor credit note.',
      COALESCE(v_bill.bill_number, _bill_id::text), v_live_pay
      USING ERRCODE = '23514';
  END IF;

  IF v_bill.business_id IS NOT NULL AND NOT public.is_period_open(v_bill.business_id, v_date) THEN
    RAISE EXCEPTION 'The accounting period covering % is closed. Raise a vendor credit note in an open period instead.', v_date
      USING ERRCODE = '23514';
  END IF;

  -- ------------------------------------------------- reverse every live JE
  FOR v_je IN
    SELECT je.id, je.entry_number
      FROM public.journal_entries je
     WHERE je.organization_id = v_bill.organization_id
       AND je.source_type = 'bill'
       AND je.source_id = _bill_id
       AND je.status::text NOT IN ('voided', 'reversed')
  LOOP
    v_rev := public.void_journal_entry_atomic(
      v_je.id,
      'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
      _actor,
      NULL,
      v_date);
    IF v_rev IS NOT NULL THEN
      v_reversals := v_reversals || v_rev;
    END IF;
  END LOOP;

  -- Legacy single-FK linkage, for bills posted before source_type/source_id
  -- stamping existed.
  IF array_length(v_reversals, 1) IS NULL AND v_bill.journal_entry_id IS NOT NULL THEN
    SELECT je.id INTO v_je
      FROM public.journal_entries je
     WHERE je.id = v_bill.journal_entry_id
       AND je.status::text NOT IN ('voided', 'reversed');
    IF FOUND THEN
      v_rev := public.void_journal_entry_atomic(
        v_bill.journal_entry_id,
        'Void bill ' || COALESCE(v_bill.bill_number, _bill_id::text) || ': ' || _reason,
        _actor,
        NULL,
        v_date);
      IF v_rev IS NOT NULL THEN
        v_reversals := v_reversals || v_rev;
      END IF;
    END IF;
  END IF;

  -- --------------------------------------------- unwind three-way-match state
  -- The goods receipt must become billable again; the match result described a
  -- bill that no longer exists in the books.
  DELETE FROM public.bill_match_results WHERE bill_id = _bill_id;

  -- --------------------------------------------------------------- the flip
  UPDATE public.bills
     SET status      = 'void',
         amount_paid = 0,
         voided_at   = now(),
         voided_by   = _actor,
         void_reason = _reason,
         updated_at  = now()
   WHERE id = _bill_id;

  -- ------------------------------------------- restore purchase-order billing
  -- Without this the PO stays `fully_billed` with `quantity_billed` intact and
  -- can never be re-billed: a reversal that compensates the ledger but not
  -- procurement is a partial reversal.
  PERFORM public.po_resync_billed_state_for_bill(_bill_id);

  RETURN jsonb_build_object(
    'result', 'voided',
    'bill_id', _bill_id,
    'bill_number', v_bill.bill_number,
    'void_date', v_date,
    'reversal_journal_entry_ids', to_jsonb(v_reversals),
    'purchase_order_billing_restored', true,
    'client_request_id', _client_request_id);
END;
$function$;
