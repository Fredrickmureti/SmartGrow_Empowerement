-- Group D #6 — emit payment.received from pos_transactions
CREATE OR REPLACE FUNCTION public.tg_pos_transaction_emit_payment_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cash_total numeric := 0;
  v_total_paid numeric := 0;
  v_methods text[];
  v_warehouse_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.transaction_type, 'sale') <> 'sale' THEN RETURN NEW; END IF;

  SELECT
    COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(amount), 0),
    COALESCE(array_agg(DISTINCT payment_method) FILTER (WHERE payment_method IS NOT NULL), ARRAY[]::text[])
  INTO v_cash_total, v_total_paid, v_methods
  FROM public.pos_transaction_payments
  WHERE transaction_id = NEW.id;

  SELECT warehouse_id INTO v_warehouse_id
  FROM public.pos_shifts WHERE id = NEW.shift_id;

  PERFORM public.publish_business_event(
    NEW.organization_id,
    NEW.branch_id,
    v_warehouse_id,
    'payment.received',
    'pos_transaction',
    NEW.id,
    jsonb_build_object(
      'transaction_id', NEW.id,
      'transaction_number', NEW.transaction_number,
      'business_id', NEW.business_id,
      'register_id', NEW.register_id,
      'shift_id', NEW.shift_id,
      'total', NEW.total,
      'cash_total', v_cash_total,
      'total_paid', v_total_paid,
      'has_cash', v_cash_total > 0,
      'methods', to_jsonb(v_methods),
      'customer_id', NEW.customer_id
    ),
    'pos-payment:' || NEW.id::text,
    NEW.created_by
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_emit_payment_received ON public.pos_transactions;
CREATE CONSTRAINT TRIGGER trg_pos_emit_payment_received
  AFTER INSERT ON public.pos_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_pos_transaction_emit_payment_received();

COMMENT ON FUNCTION public.tg_pos_transaction_emit_payment_received() IS
  'Group D #6 — publishes payment.received to business_event_outbox at commit so the saga can fan out drawer/receipt enqueues uniformly across Electron + browser modes.';

-- =====================================================================
-- Group D #5 — default label_templates seed.
-- Postgres TEXT cannot hold a NUL byte, so any ESC/POS command that
-- normally takes a 0x00 parameter is replaced with the safe 0x01
-- equivalent. Workers re-emit the canonical bytes at print time.
-- ESC @ (init) already sets left alignment, so no separate ESC a 0 is
-- needed.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.seed_default_label_templates(p_org_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
  v_grn_body text;
  v_shelf_body text;
  v_xfer_body text;
  v_ship_body text;
BEGIN
  v_grn_body :=
    E'\x1b\x40' ||
    E'\x1b\x61\x01' ||
    E'\x1d\x21\x11' || 'GOODS RECEIVED' || E'\x0a' ||
    E'\x1b\x40' || E'\x0a' ||
    'GRN: {{grn_id}}' || E'\x0a' ||
    'PO:  {{purchase_order_id}}' || E'\x0a' ||
    'Status: {{status}}' || E'\x0a' ||
    '--------------------------------' || E'\x0a' ||
    E'\x0a\x0a\x0a' ||
    E'\x1d\x56\x42\x01';

  v_shelf_body :=
    E'\x1b\x40' ||
    E'\x1b\x21\x30' || '{{product_id}}' || E'\x0a' ||
    E'\x1b\x40' ||
    'Qty: {{quantity}}' || E'\x0a' ||
    'Lot: {{lot_number}}  Exp: {{expiry_date}}' || E'\x0a' ||
    E'\x0a\x0a' ||
    E'\x1d\x56\x42\x01';

  v_xfer_body :=
    E'\x1b\x40' ||
    E'\x1b\x61\x01' ||
    E'\x1d\x21\x11' || 'STOCK TRANSFER' || E'\x0a' ||
    E'\x1b\x40' || E'\x0a' ||
    'Transfer: {{transferId}}' || E'\x0a' ||
    '--------------------------------' || E'\x0a' ||
    E'\x0a\x0a\x0a' ||
    E'\x1d\x56\x42\x01';

  v_ship_body :=
    '^XA' || E'\n' ||
    '^CF0,40' || E'\n' ||
    '^FO30,30^FDDelivery: {{deliveryNoteId}}^FS' || E'\n' ||
    '^CF0,28' || E'\n' ||
    '^FO30,90^FDTo: {{customer_name}}^FS' || E'\n' ||
    '^FO30,130^FDAddress: {{customer_address}}^FS' || E'\n' ||
    '^BY3,2,80^FO30,220^BCN,80,Y,N,N^FD{{deliveryNoteId}}^FS' || E'\n' ||
    '^XZ';

  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, width_mm, height_mm, is_default)
  VALUES
    (p_org_id, NULL, 'grn_summary',       'grn_summary',       'GRN Summary (default)',       'escpos', v_grn_body,   80,  NULL, true),
    (p_org_id, NULL, 'shelf_edge',        'shelf_edge',        'Shelf Edge (default)',        'escpos', v_shelf_body, 58,  NULL, true),
    (p_org_id, NULL, 'transfer_manifest', 'transfer_manifest', 'Transfer Manifest (default)', 'escpos', v_xfer_body,  80,  NULL, true),
    (p_org_id, NULL, 'shipping_label',    'shipping_label',    'Shipping Label (default)',    'zpl',    v_ship_body, 102, 152,  true)
  ON CONFLICT (org_id, template_key) WHERE branch_id IS NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_label_templates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_label_templates(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_org_seed_label_templates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_label_templates(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_seed_label_templates ON public.organizations;
CREATE TRIGGER trg_org_seed_label_templates
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_org_seed_label_templates();

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_label_templates(r.id);
  END LOOP;
END $$;