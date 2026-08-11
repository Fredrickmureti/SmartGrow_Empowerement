-- 1. System-scope AST template for the purchase return note (RMA).
INSERT INTO public.document_template_ast (kind_code, scope, label, version, is_default, is_active, ast)
SELECT 'purchases.return', 'system', 'System default — Purchase Return', 1, true, true,
  jsonb_build_object(
    'kind', 'purchases.return',
    'version', 1,
    'media_class', 'a4_portrait',
    'blocks', jsonb_build_array(
      jsonb_build_object('type','header','variant','branded'),
      jsonb_build_object('type','party','role','vendor'),
      jsonb_build_object('type','meta','fields', jsonb_build_array('number','date','currency')),
      jsonb_build_object('type','table','preset','line_items'),
      jsonb_build_object('type','totals','preset','standard'),
      jsonb_build_object('type','notes','source','terms'),
      jsonb_build_object('type','footer','variant','branded')
    ))
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_template_ast
  WHERE kind_code='purchases.return' AND scope='system'
);

-- 2. Email ledger must accept the purchase return document type.
ALTER TABLE public.document_emails DROP CONSTRAINT IF EXISTS document_emails_document_type_check;
ALTER TABLE public.document_emails ADD CONSTRAINT document_emails_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'invoice','estimate','proforma','credit_note','delivery_note','purchase_order','bill',
    'customer_statement','vendor_statement','receipt','sales_return','sales_order','report',
    'payslip','pos_receipt','contract_letter','offer_letter','promotion_letter','warning_letter',
    'purchase_return','rfq']));

-- 3. Supplier-notification event emitted from the dispatch command.
CREATE OR REPLACE FUNCTION public._pret_emit_outbox(_pr public.purchase_returns, _state text, _payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.business_event_outbox
    (org_id, branch_id, warehouse_id, source, event_type,
     source_doc_type, source_doc_id, payload,
     idempotency_key, status, actor_user_id, created_at)
  VALUES (_pr.organization_id, _pr.branch_id, _pr.warehouse_id, 'procurement',
          'procurement.return.' || _state,
          'purchase_return', _pr.id, COALESCE(_payload, '{}'::jsonb),
          'procurement.return.' || _state || ':' || _pr.id::text,
          'pending', auth.uid(), now())
  ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION public._pret_emit_outbox(public.purchase_returns, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.purchase_return_dispatch(_id uuid, _row_version integer, _dispatch_date date DEFAULT NULL::date, _tracking_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pr public.purchase_returns; v_branch uuid; v_moves int := 0;
BEGIN
  v_pr := public._pret_load(_id, _row_version);
  IF v_pr.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved returns can be dispatched' USING ERRCODE='22023';
  END IF;
  IF v_pr.return_kind <> 'goods' THEN
    RAISE EXCEPTION 'A financial adjustment has no goods to dispatch' USING ERRCODE='22023';
  END IF;
  IF v_pr.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'This return has no warehouse — stock cannot be released' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_movements
              WHERE reference_type='purchase_return' AND reference_id=_id) THEN
    RAISE EXCEPTION 'Stock for this return has already been released' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(v_pr.branch_id, w.branch_id) INTO v_branch
    FROM public.warehouses w WHERE w.id = v_pr.warehouse_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve the branch for this warehouse' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.stock_movements(
    organization_id, business_id, branch_id, warehouse_id, product_id, movement_type,
    quantity, unit_cost, reference_type, reference_id, notes, created_by,
    lot_number, serial_number, source_packaging_id, source_uom_id, source_location_id, movement_date)
  SELECT v_pr.organization_id, v_pr.business_id, v_branch, v_pr.warehouse_id, ri.product_id, 'return',
         -ri.quantity, COALESCE(ri.unit_cost_basis, ri.unit_price), 'purchase_return', v_pr.id,
         'Purchase return ' || v_pr.return_number || ' dispatched to vendor',
         auth.uid(), ri.lot_number, ri.serial_number, ri.packaging_id, ri.display_uom_id,
         ri.location_id, COALESCE(_dispatch_date, CURRENT_DATE)::timestamptz
    FROM public.purchase_return_items ri
   WHERE ri.purchase_return_id = v_pr.id AND ri.product_id IS NOT NULL;
  GET DIAGNOSTICS v_moves = ROW_COUNT;

  PERFORM public._pret_lifecycle_begin();
  UPDATE public.purchase_returns
     SET status='dispatched', dispatched_at=now(), dispatched_by=auth.uid(),
         rma_reference=COALESCE(_tracking_reference, rma_reference),
         row_version=row_version+1, updated_at=now()
   WHERE id=_id;
  SELECT * INTO v_pr FROM public.purchase_returns WHERE id=_id;
  PERFORM public._pret_log(v_pr, 'dispatched', 'approved', 'dispatched',
                           jsonb_build_object('stock_movements', v_moves,
                                              'tracking_reference', _tracking_reference));
  PERFORM public._pret_emit_outbox(v_pr, 'dispatched',
    jsonb_build_object('return_number', v_pr.return_number,
                       'vendor_id', v_pr.vendor_id,
                       'rma_reference', v_pr.rma_reference,
                       'stock_movements', v_moves,
                       'dispatched_at', v_pr.dispatched_at));
  RETURN jsonb_build_object('success', true, 'row_version', v_pr.row_version, 'stock_movements', v_moves);
END $function$;
