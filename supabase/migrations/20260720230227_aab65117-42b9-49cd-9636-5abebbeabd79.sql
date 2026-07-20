-- D1 (ADR-0086) — consolidate the server-side `inventory_label` ZPL body
-- onto label_templates so the renderer stops shipping a hardcoded stub.
--
-- The body preserves the on-wire shape of the legacy hardcoded emitter
-- (^PW640/^LL400 envelope, CODE128 barcode, SKU sub-line) so existing
-- printers keep receiving byte-compatible output. Vars are substituted by
-- renderTemplateBody() in the edge-function builder.

-- (1) Extend the org seeder to include inventory_label.
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
  v_inv_body text;
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

  -- Inventory label: on-wire shape matches the pre-D1 hardcoded body in
  -- supabase/functions/_shared/printing/zpl/builder.ts so callers see no
  -- byte drift after the builder is repointed at label_templates.
  v_inv_body :=
    '^XA' || E'\n' ||
    '^PW640' || E'\n' ||
    '^LL400' || E'\n' ||
    '^CF0,30' || E'\n' ||
    '^FO20,20^FD{{name}}^FS' || E'\n' ||
    '^FO20,60^FDSKU: {{sku}}^FS' || E'\n' ||
    '^CF0,40^FO20,100^FD{{price}}^FS' || E'\n' ||
    '^BY2,2,80' || E'\n' ||
    '^FO20,180^BCN,80,Y,N,N^FD{{barcode}}^FS' || E'\n' ||
    '^XZ';

  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, width_mm, height_mm, is_default)
  VALUES
    (p_org_id, NULL, 'grn_summary',       'grn_summary',       'GRN Summary (default)',       'escpos', v_grn_body,   80,  NULL, true),
    (p_org_id, NULL, 'shelf_edge',        'shelf_edge',        'Shelf Edge (default)',        'escpos', v_shelf_body, 58,  NULL, true),
    (p_org_id, NULL, 'transfer_manifest', 'transfer_manifest', 'Transfer Manifest (default)', 'escpos', v_xfer_body,  80,  NULL, true),
    (p_org_id, NULL, 'shipping_label',    'shipping_label',    'Shipping Label (default)',    'zpl',    v_ship_body, 102, 152,  true),
    (p_org_id, NULL, 'product',           'inventory_label',   'Inventory Label (default)',   'zpl',    v_inv_body,   80,  50,   true)
  ON CONFLICT (org_id, template_key) WHERE branch_id IS NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_label_templates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_label_templates(uuid) TO authenticated, service_role;

-- (2) Backfill: idempotently insert the inventory_label row for every
-- existing org that hasn't got one (branch_id IS NULL scope).
INSERT INTO public.label_templates
  (org_id, branch_id, kind, template_key, name, engine, body,
   width_mm, height_mm, is_default, version, active)
SELECT
  o.id,
  NULL::uuid,
  'product',
  'inventory_label',
  'Inventory Label (default)',
  'zpl'::public.label_engine,
  E'^XA\n^PW640\n^LL400\n^CF0,30\n^FO20,20^FD{{name}}^FS\n^FO20,60^FDSKU: {{sku}}^FS\n^CF0,40^FO20,100^FD{{price}}^FS\n^BY2,2,80\n^FO20,180^BCN,80,Y,N,N^FD{{barcode}}^FS\n^XZ',
  80,
  50,
  true,
  1,
  true
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM public.label_templates lt
  WHERE lt.org_id = o.id
    AND lt.branch_id IS NULL
    AND lt.template_key = 'inventory_label'
);
