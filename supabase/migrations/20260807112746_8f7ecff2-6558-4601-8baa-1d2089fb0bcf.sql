-- Core projection extracted so the Phase 4 wrapper can compose on top of it.
CREATE OR REPLACE FUNCTION public.preview_reversal_consequences_core(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_intent      jsonb;
  v_org         uuid;
  v_biz         uuid;
  v_gl          jsonb := '[]'::jsonb;
  v_gl_total    numeric := 0;
  v_stock       jsonb := '[]'::jsonb;
  v_money       jsonb := '[]'::jsonb;
  v_docs        jsonb := '[]'::jsonb;
  v_warnings    jsonb := '[]'::jsonb;
  v_fiscalized  boolean := false;
  v_dn_count    int := 0;
  v_cn_count    int := 0;
  v_grn_count   int := 0;
  v_bill_count  int := 0;
  v_match       RECORD;
BEGIN
  v_intent := public.resolve_reversal_intent(_document_type, _document_id);
  v_org := NULLIF(v_intent->>'organization_id', '')::uuid;
  v_biz := NULLIF(v_intent->>'business_id', '')::uuid;

  -- ------------------------------------------------------------------ GL
  WITH jes AS (
    SELECT je.id,
           je.entry_number,
           je.entry_date,
           COALESCE(je.source_subtype, 'main') AS subtype,
           COALESCE(je.total_debit, 0)         AS total_debit,
           je.status::text                     AS status
      FROM public.journal_entries je
     WHERE je.organization_id = v_org
       AND je.status::text NOT IN ('voided', 'reversed')
       AND je.source_type = _document_type
       AND je.source_id   = _document_id
  ),
  lines AS (
    SELECT jel.journal_entry_id,
           jsonb_agg(jsonb_build_object(
             'account_id',     jel.account_id,
             'account_code',   a.code,
             'account_name',   a.name,
             'reverse_debit',  COALESCE(jel.credit, 0),
             'reverse_credit', COALESCE(jel.debit, 0)
           ) ORDER BY a.code) AS lines
      FROM public.journal_entry_lines jel
      LEFT JOIN public.accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id IN (SELECT id FROM jes)
     GROUP BY jel.journal_entry_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'journal_entry_id', jes.id,
           'entry_number',     jes.entry_number,
           'entry_date',       jes.entry_date,
           'subtype',          jes.subtype,
           'total',            jes.total_debit,
           'status',           jes.status,
           'lines',            COALESCE(lines.lines, '[]'::jsonb)
         ) ORDER BY jes.subtype), '[]'::jsonb),
         COALESCE(SUM(jes.total_debit), 0)
    INTO v_gl, v_gl_total
    FROM jes LEFT JOIN lines ON lines.journal_entry_id = jes.id;

  -- --------------------------------------------------------------- invoice
  IF _document_type = 'invoice' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'product_name'), '[]'::jsonb)
      INTO v_stock
      FROM (
        SELECT jsonb_build_object(
                 'product_id',     sm.product_id,
                 'product_name',   p.name,
                 'product_sku',    p.sku,
                 'warehouse_id',   sm.warehouse_id,
                 'warehouse_name', w.name,
                 'quantity',       SUM(sm.quantity),
                 'unit_cost',      MAX(sm.unit_cost),
                 'direction',      'return_in'
               ) AS x
          FROM public.stock_movements sm
          JOIN public.products p ON p.id = sm.product_id
          LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
         WHERE sm.reference_type = 'invoice'
           AND sm.reference_id   = _document_id
           AND COALESCE(p.track_inventory, false) = true
         GROUP BY sm.product_id, p.name, p.sku, sm.warehouse_id, w.name
      ) s;

    IF EXISTS (
      SELECT 1 FROM public.stock_movements
       WHERE reference_type = 'invoice_void' AND reference_id = _document_id
    ) THEN
      v_stock := '[]'::jsonb;
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'stock_already_restored',
        'severity', 'info',
        'message', 'Stock for this invoice was already returned to inventory. No further stock movement would be created.');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'payment_id',       p.id,
             'receipt_number',   p.receipt_number,
             'payment_date',     p.payment_date,
             'payment_method',   p.payment_method,
             'allocated_amount', a.amount,
             'payment_amount',   p.amount,
             'bank_reconciled',  public.payment_is_bank_reconciled(p.id)
           ) ORDER BY p.payment_date), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.payments p ON p.id = a.payment_id
     WHERE a.invoice_id = _document_id
       AND COALESCE(p.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT count(*) INTO v_dn_count
      FROM public.delivery_notes dn
     WHERE (dn.source_invoice_id = _document_id OR dn.spawned_invoice_id = _document_id)
       AND COALESCE(dn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT count(*) INTO v_cn_count
      FROM public.credit_notes cn
     WHERE cn.invoice_id = _document_id
       AND COALESCE(cn.status::text, '') NOT IN ('cancelled', 'voided');

    SELECT EXISTS (
      SELECT 1 FROM public.fiscal_transmissions ft
       WHERE ft.source_doc_type = 'invoice'
         AND ft.source_doc_id = _document_id
         AND ft.state = 'succeeded'
    ) INTO v_fiscalized;

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'delivery_note', 'label', 'Delivery notes', 'count', v_dn_count),
      jsonb_build_object('kind', 'credit_note',   'label', 'Credit notes',   'count', v_cn_count),
      jsonb_build_object('kind', 'fiscal_receipt','label', 'Fiscal receipt',
                         'count', CASE WHEN v_fiscalized THEN 1 ELSE 0 END)
    );

    IF v_fiscalized THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'fiscal_transmitted',
        'severity', 'warning',
        'message', 'This invoice was already accepted by the tax authority. Most jurisdictions require a credit note to cancel a fiscalised invoice — a local void does not withdraw the transmission.');
    END IF;

    IF v_dn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'delivery_note_linked',
        'severity', 'warning',
        'message', v_dn_count || ' delivery note(s) are linked to this invoice. Goods dispatched on a delivery note come back through a sales return, not by voiding the invoice.');
    END IF;

    IF v_cn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'credit_note_exists',
        'severity', 'warning',
        'message', v_cn_count || ' credit note(s) already correct this invoice. Reversing it again would compensate the customer twice.');
    END IF;

  -- --------------------------------------------------------------- payment
  ELSIF _document_type = 'payment' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'invoice_id',        i.id,
             'invoice_number',    i.invoice_number,
             'invoice_total',     i.total,
             'allocated_amount',  a.amount,
             'amount_paid_now',   i.amount_paid,
             'amount_paid_after', GREATEST(COALESCE(i.amount_paid, 0) - a.amount, 0),
             'status_now',        i.status::text
           ) ORDER BY i.invoice_number), '[]'::jsonb)
      INTO v_money
      FROM public.payment_allocations a
      JOIN public.invoices i ON i.id = a.invoice_id
     WHERE a.payment_id = _document_id;

    IF public.payment_is_bank_reconciled(_document_id) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'bank_reconciled',
        'severity', 'error',
        'message', 'This payment is matched to a reconciled bank statement line. Un-reconcile the bank line before reversing, or the reconciliation and the ledger will disagree.');
    END IF;

  -- ------------------------------------------------------------------- bill
  ELSIF _document_type = 'bill' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'payment_id',       bp.id,
             'receipt_number',   bp.reference,
             'payment_date',     bp.payment_date,
             'payment_method',   bp.payment_method,
             'allocated_amount', a.amount,
             'payment_amount',   bp.amount,
             'bank_reconciled',  public.bill_payment_is_bank_reconciled(bp.id)
           ) ORDER BY bp.payment_date), '[]'::jsonb)
      INTO v_money
      FROM public.bill_payment_allocations a
      JOIN public.bill_payments bp ON bp.id = a.bill_payment_id
     WHERE a.bill_id = _document_id
       AND COALESCE(bp.status, 'completed') NOT IN ('voided', 'cancelled');

    SELECT count(*) INTO v_grn_count
      FROM public.goods_receipts g
      JOIN public.bills b ON b.goods_receipt_id = g.id
     WHERE b.id = _document_id;

    SELECT count(*) INTO v_cn_count
      FROM public.vendor_credit_notes vcn
     WHERE vcn.bill_id = _document_id
       AND COALESCE(vcn.status::text, '') NOT IN ('cancelled', 'voided');

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'goods_receipt',      'label', 'Goods receipts',      'count', v_grn_count),
      jsonb_build_object('kind', 'vendor_credit_note', 'label', 'Vendor credit notes', 'count', v_cn_count)
    );

    SELECT match_state::text AS state, exception_state::text AS exception
      INTO v_match
      FROM public.bill_match_results
     WHERE bill_id = _document_id
     LIMIT 1;

    IF FOUND THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'three_way_match_unwound',
        'severity', 'info',
        'message', 'This bill is matched to its purchase order and goods receipt (' || COALESCE(v_match.state, 'matched') ||
                   '). Voiding it releases that match, so the receipt becomes billable again.');
    END IF;

    IF v_cn_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'vendor_credit_note_exists',
        'severity', 'warning',
        'message', v_cn_count || ' vendor credit note(s) already correct this bill. Voiding it as well would credit the supplier twice.');
    END IF;

  -- ----------------------------------------------------------- bill_payment
  ELSIF _document_type = 'bill_payment' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'invoice_id',        b.id,
             'invoice_number',    b.bill_number,
             'invoice_total',     b.total,
             'allocated_amount',  a.amount,
             'amount_paid_now',   b.amount_paid,
             'amount_paid_after', GREATEST(COALESCE(b.amount_paid, 0) - a.amount, 0),
             'status_now',        b.status::text
           ) ORDER BY b.bill_number), '[]'::jsonb)
      INTO v_money
      FROM public.bill_payment_allocations a
      JOIN public.bills b ON b.id = a.bill_id
     WHERE a.bill_payment_id = _document_id;

    IF public.bill_payment_is_bank_reconciled(_document_id) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'bank_reconciled',
        'severity', 'error',
        'message', 'This supplier payment is matched to a reconciled bank statement line. Un-reconcile the bank line before reversing, or the reconciliation and the ledger will disagree.');
    END IF;

  -- ---------------------------------------------------------- goods_receipt
  ELSIF _document_type = 'goods_receipt' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'product_name'), '[]'::jsonb)
      INTO v_stock
      FROM (
        SELECT jsonb_build_object(
                 'product_id',     gi.product_id,
                 'product_name',   p.name,
                 'product_sku',    p.sku,
                 'warehouse_id',   g.warehouse_id,
                 'warehouse_name', w.name,
                 'quantity',       SUM(COALESCE(gi.quantity_received, 0)),
                 'unit_cost',      MAX(gi.unit_cost_basis),
                 'direction',      'return_out'
               ) AS x
          FROM public.goods_receipt_items gi
          JOIN public.goods_receipts g ON g.id = gi.goods_receipt_id
          JOIN public.products p ON p.id = gi.product_id
          LEFT JOIN public.warehouses w ON w.id = g.warehouse_id
         WHERE gi.goods_receipt_id = _document_id
           AND COALESCE(gi.quantity_received, 0) > 0
           AND COALESCE(p.track_inventory, false) = true
         GROUP BY gi.product_id, p.name, p.sku, g.warehouse_id, w.name
      ) s;

    SELECT count(*) INTO v_bill_count
      FROM public.bills b
     WHERE b.goods_receipt_id = _document_id
       AND b.status::text <> 'void';

    v_docs := jsonb_build_array(
      jsonb_build_object('kind', 'bill', 'label', 'Supplier bills', 'count', v_bill_count)
    );

    IF v_bill_count > 0 THEN
      v_warnings := v_warnings || jsonb_build_object(
        'code', 'receipt_already_billed',
        'severity', 'error',
        'message', v_bill_count || ' supplier bill(s) already cover this receipt. Returning the goods without voiding or crediting the bill would leave the liability on the books.');
    END IF;
  END IF;

  IF jsonb_array_length(v_gl) = 0 AND COALESCE((v_intent->'state'->>'is_posted')::boolean, false) THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'no_gl_entry',
      'severity', 'warning',
      'message', 'No live accounting entry was found for this posted document. Reversing it changes the document only — check the ledger before continuing.');
  END IF;

  RETURN jsonb_build_object(
    'document_type',      _document_type,
    'document_id',        _document_id,
    'document_number',    v_intent->>'document_number',
    'organization_id',    v_org,
    'business_id',        v_biz,
    'intent',             v_intent,
    'gl',                 jsonb_build_object(
                            'entries', v_gl,
                            'entry_count', jsonb_array_length(v_gl),
                            'total_reversed', v_gl_total),
    'stock',              jsonb_build_object(
                            'lines', v_stock,
                            'line_count', jsonb_array_length(v_stock)),
    'money',              jsonb_build_object(
                            'lines', v_money,
                            'line_count', jsonb_array_length(v_money)),
    'related_documents',  v_docs,
    'warnings',           v_warnings
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_reversal_consequences_core(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences_core(text, uuid) TO authenticated;
