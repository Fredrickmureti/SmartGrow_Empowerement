-- Phase 6.1 — Returns document kinds
INSERT INTO public.document_kinds (code, label, domain, legal_class, requires_party, default_media_class, default_intents, allowed_formats, is_active)
VALUES
  ('wms.rma_authorization', 'RMA Authorization', 'wms', 'contractual', true,  'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'], true),
  ('wms.return_receipt',    'Return Receipt',    'wms', 'contractual', true,  'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf'], true),
  ('wms.inspection_report', 'Return Inspection Report', 'wms', 'none', false, 'a4_portrait', ARRAY['view','download','print'],         ARRAY['pdf'], true),
  ('wms.damage_report',     'Return Damage Report',     'wms', 'none', false, 'a4_portrait', ARRAY['view','download','email','print'], ARRAY['pdf'], true)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  domain = EXCLUDED.domain,
  legal_class = EXCLUDED.legal_class,
  requires_party = EXCLUDED.requires_party,
  default_media_class = EXCLUDED.default_media_class,
  default_intents = EXCLUDED.default_intents,
  allowed_formats = EXCLUDED.allowed_formats,
  is_active = true;

-- Phase 6.2 — Finance handoff: create the sales/purchase return header from a
-- posted warehouse return. Warehouse only creates the shell and links it;
-- valuation, tax and posting remain Finance's responsibility (all money
-- columns are written as zero and the header lands in 'pending').
CREATE OR REPLACE FUNCTION public.wms_create_return_finance_doc(
  p_return_id uuid,
  p_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ord public.wms_return_orders%ROWTYPE;
  v_branch uuid;
  v_doc_type text;
  v_doc_id uuid;
  v_number text;
  v_currency text := 'USD';
  v_unposted integer;
  v_lines integer;
  v_new_version integer;
BEGIN
  SELECT * INTO v_ord FROM public.wms_return_orders WHERE id = p_return_id FOR UPDATE;
  IF v_ord.id IS NULL THEN
    RAISE EXCEPTION 'return order % not found', p_return_id USING ERRCODE = '22023';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_ord.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;
  IF v_ord.row_version <> p_row_version THEN
    RAISE EXCEPTION 'return changed since it was loaded (row_version % <> %)', v_ord.row_version, p_row_version
      USING ERRCODE = '40001';
  END IF;
  IF v_ord.state = 'cancelled' THEN
    RAISE EXCEPTION 'cannot raise a finance document for a cancelled return' USING ERRCODE = '22023';
  END IF;

  -- Idempotency: a return carries exactly one finance document.
  IF v_ord.finance_doc_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'return_id', v_ord.id,
      'row_version', v_ord.row_version,
      'finance_doc_type', v_ord.finance_doc_type,
      'finance_doc_id', v_ord.finance_doc_id,
      'created', false
    );
  END IF;

  SELECT count(*), count(*) FILTER (WHERE posted_at IS NULL)
    INTO v_lines, v_unposted
    FROM public.wms_return_lines
   WHERE return_order_id = v_ord.id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'return has no lines' USING ERRCODE = '22023';
  END IF;
  IF v_unposted > 0 THEN
    RAISE EXCEPTION 'post all dispositions before raising the finance document (% unposted line(s))', v_unposted
      USING ERRCODE = '22023';
  END IF;

  v_branch := COALESCE(v_ord.branch_id, (SELECT branch_id FROM public.warehouses WHERE id = v_ord.warehouse_id));

  IF v_ord.return_kind = 'customer' THEN
    IF v_ord.customer_id IS NULL THEN
      RAISE EXCEPTION 'a customer return needs a customer before a sales return can be raised' USING ERRCODE = '22023';
    END IF;
    v_doc_type := 'sales_return';
    v_number := 'SR-' || to_char(now(), 'YYYYMM') || '-' || upper(substr(replace(v_ord.id::text, '-', ''), 1, 6));

    SELECT COALESCE(i.currency, 'USD') INTO v_currency
      FROM public.invoices i
     WHERE v_ord.source_doc_type = 'invoice' AND i.id = v_ord.source_doc_id;
    v_currency := COALESCE(v_currency, 'USD');

    INSERT INTO public.sales_returns (
      organization_id, business_id, branch_id, contact_id, return_number, return_date,
      status, invoice_id, reason, currency, subtotal, tax_amount, total, notes, created_by
    ) VALUES (
      v_ord.organization_id, v_ord.business_id, v_branch, v_ord.customer_id, v_number, current_date,
      'pending',
      CASE WHEN v_ord.source_doc_type = 'invoice' THEN v_ord.source_doc_id ELSE NULL END,
      COALESCE(v_ord.notes, 'Warehouse return ' || v_ord.code),
      v_currency, 0, 0, 0,
      'Raised from warehouse return ' || v_ord.code, auth.uid()
    ) RETURNING id INTO v_doc_id;

    INSERT INTO public.sales_return_items (
      sales_return_id, product_id, description, quantity, unit_price, tax_rate, tax_amount,
      line_total, return_reason, condition, lot_number, serial_number, sort_order
    )
    SELECT v_doc_id, l.product_id,
           COALESCE(p.name, 'Returned item'),
           GREATEST(COALESCE(l.received_qty, 0), 0),
           0, 0, 0, 0,
           l.notes, l.condition_code::text, l.lot_number, l.serial_number,
           row_number() OVER (ORDER BY l.created_at)
      FROM public.wms_return_lines l
      LEFT JOIN public.products p ON p.id = l.product_id
     WHERE l.return_order_id = v_ord.id;

  ELSIF v_ord.return_kind = 'vendor' THEN
    IF v_ord.vendor_id IS NULL THEN
      RAISE EXCEPTION 'a vendor return needs a vendor before a purchase return can be raised' USING ERRCODE = '22023';
    END IF;
    v_doc_type := 'purchase_return';
    v_number := 'PR-' || to_char(now(), 'YYYYMM') || '-' || upper(substr(replace(v_ord.id::text, '-', ''), 1, 6));

    SELECT COALESCE(b.currency, 'USD') INTO v_currency
      FROM public.bills b
     WHERE v_ord.source_doc_type = 'bill' AND b.id = v_ord.source_doc_id;
    v_currency := COALESCE(v_currency, 'USD');

    INSERT INTO public.purchase_returns (
      organization_id, business_id, branch_id, vendor_id, return_number, return_date,
      status, bill_id, reason, currency, subtotal, tax_amount, total, notes, created_by
    ) VALUES (
      v_ord.organization_id, v_ord.business_id, v_branch, v_ord.vendor_id, v_number, current_date,
      'pending',
      CASE WHEN v_ord.source_doc_type = 'bill' THEN v_ord.source_doc_id ELSE NULL END,
      COALESCE(v_ord.notes, 'Warehouse return ' || v_ord.code),
      v_currency, 0, 0, 0,
      'Raised from warehouse return ' || v_ord.code, auth.uid()
    ) RETURNING id INTO v_doc_id;

    INSERT INTO public.purchase_return_items (
      purchase_return_id, product_id, description, quantity, unit_price, tax_rate, tax_amount,
      line_total, return_reason, condition, sort_order
    )
    SELECT v_doc_id, l.product_id,
           COALESCE(p.name, 'Returned item'),
           GREATEST(COALESCE(l.received_qty, 0), 0),
           0, 0, 0, 0,
           l.notes, l.condition_code::text,
           row_number() OVER (ORDER BY l.created_at)
      FROM public.wms_return_lines l
      LEFT JOIN public.products p ON p.id = l.product_id
     WHERE l.return_order_id = v_ord.id;

  ELSE
    RAISE EXCEPTION 'internal and transfer returns have no finance counterpart' USING ERRCODE = '22023';
  END IF;

  v_new_version := v_ord.row_version + 1;

  UPDATE public.wms_return_orders
     SET finance_doc_type = v_doc_type,
         finance_doc_id   = v_doc_id,
         row_version      = v_new_version,
         updated_at       = now()
   WHERE id = v_ord.id;

  PERFORM public._wms_emit_outbox(
    'warehouse.return.finance_linked',
    'wms.return:' || v_ord.id::text || ':finance_linked:' || v_new_version::text,
    v_ord.organization_id, v_ord.business_id,
    jsonb_build_object(
      'aggregate_id', v_ord.id,
      'warehouse_id', v_ord.warehouse_id,
      'branch_id', v_branch,
      'actor_id', auth.uid(),
      'occurred_at', now(),
      'extra', jsonb_build_object(
        'finance_doc_type', v_doc_type,
        'finance_doc_id', v_doc_id,
        'credit_note_id', NULL,
        'origin', 'wms_create_return_finance_doc'
      )
    )
  );

  RETURN jsonb_build_object(
    'return_id', v_ord.id,
    'row_version', v_new_version,
    'finance_doc_type', v_doc_type,
    'finance_doc_id', v_doc_id,
    'document_number', v_number,
    'created', true
  );
END
$$;

REVOKE ALL ON FUNCTION public.wms_create_return_finance_doc(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_create_return_finance_doc(uuid, integer) TO authenticated;