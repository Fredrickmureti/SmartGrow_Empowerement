
-- Phase 10 (ADR-0087) — Seed cleanup: envelope moves to the driver.

CREATE OR REPLACE FUNCTION public.seed_default_label_templates(p_org_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
  v_grn_body text;
  v_shelf_body text;
  v_xfer_body text;
  v_ship_body text;
  v_inv_body text;
  v_media_receipt_80 uuid;
  v_media_label_50x30 uuid;
  v_media_label_80x50 uuid;
  v_media_label_100x150 uuid;
BEGIN
  -- Resolve media profiles for the org (seeded by seed_default_media_profiles).
  SELECT id INTO v_media_receipt_80   FROM public.media_profiles WHERE org_id = p_org_id AND code = 'receipt_80';
  SELECT id INTO v_media_label_50x30  FROM public.media_profiles WHERE org_id = p_org_id AND code = 'label_50x30';
  SELECT id INTO v_media_label_80x50  FROM public.media_profiles WHERE org_id = p_org_id AND code = 'label_80x50';
  SELECT id INTO v_media_label_100x150 FROM public.media_profiles WHERE org_id = p_org_id AND code = 'label_100x150';

  v_grn_body :=
    E'\x1b\x40' || E'\x1b\x61\x01' ||
    E'\x1d\x21\x11' || 'GOODS RECEIVED' || E'\x0a' ||
    E'\x1b\x40' || E'\x0a' ||
    'GRN: {{grn_id}}' || E'\x0a' ||
    'PO:  {{purchase_order_id}}' || E'\x0a' ||
    'Status: {{status}}' || E'\x0a' ||
    '--------------------------------' || E'\x0a' ||
    E'\x0a\x0a\x0a' || E'\x1d\x56\x42\x01';

  v_shelf_body :=
    E'\x1b\x40' || E'\x1b\x21\x30' || '{{product_id}}' || E'\x0a' ||
    E'\x1b\x40' ||
    'Qty: {{quantity}}' || E'\x0a' ||
    'Lot: {{lot_number}}  Exp: {{expiry_date}}' || E'\x0a' ||
    E'\x0a\x0a' || E'\x1d\x56\x42\x01';

  v_xfer_body :=
    E'\x1b\x40' || E'\x1b\x61\x01' ||
    E'\x1d\x21\x11' || 'STOCK TRANSFER' || E'\x0a' ||
    E'\x1b\x40' || E'\x0a' ||
    'Transfer: {{transferId}}' || E'\x0a' ||
    '--------------------------------' || E'\x0a' ||
    E'\x0a\x0a\x0a' || E'\x1d\x56\x42\x01';

  -- ADR-0087 — no ^PW / ^LL. Envelope is injected by the driver from the
  -- resolved media profile so the same body scales to any label size.
  v_ship_body :=
    '^XA' || E'\n' ||
    '^CF0,40' || E'\n' ||
    '^FO30,30^FDDelivery: {{deliveryNoteId}}^FS' || E'\n' ||
    '^CF0,28' || E'\n' ||
    '^FO30,90^FDTo: {{customer_name}}^FS' || E'\n' ||
    '^FO30,130^FDAddress: {{customer_address}}^FS' || E'\n' ||
    '^BY3,2,80^FO30,220^BCN,80,Y,N,N^FD{{deliveryNoteId}}^FS' || E'\n' ||
    '^XZ';

  v_inv_body :=
    '^XA' || E'\n' ||
    '^CF0,30' || E'\n' ||
    '^FO20,20^FD{{name}}^FS' || E'\n' ||
    '^FO20,60^FDSKU: {{sku}}^FS' || E'\n' ||
    '^CF0,40^FO20,100^FD{{price}}^FS' || E'\n' ||
    '^BY2,2,80' || E'\n' ||
    '^FO20,180^BCN,80,Y,N,N^FD{{barcode}}^FS' || E'\n' ||
    '^XZ';

  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body, width_mm, height_mm, is_default, media_profile_id)
  VALUES
    (p_org_id, NULL, 'grn_summary',       'grn_summary',       'GRN Summary (default)',       'escpos', v_grn_body,   80,  NULL, true, v_media_receipt_80),
    (p_org_id, NULL, 'shelf_edge',        'shelf_edge',        'Shelf Edge (default)',        'escpos', v_shelf_body, 58,  NULL, true, v_media_receipt_80),
    (p_org_id, NULL, 'transfer_manifest', 'transfer_manifest', 'Transfer Manifest (default)', 'escpos', v_xfer_body,  80,  NULL, true, v_media_receipt_80),
    (p_org_id, NULL, 'shipping_label',    'shipping_label',    'Shipping Label (default)',    'zpl',    v_ship_body, 100, 150,  true, v_media_label_100x150),
    (p_org_id, NULL, 'product',           'inventory_label',   'Inventory Label (default)',   'zpl',    v_inv_body,   80,  50,   true, v_media_label_80x50)
  ON CONFLICT (org_id, template_key, COALESCE(media_profile_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE branch_id IS NULL
    DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $$;

REVOKE ALL ON FUNCTION public.seed_default_label_templates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_label_templates(uuid) TO authenticated, service_role;

-- Backfill: strip embedded ^PW / ^LL from every existing template body.
-- The driver re-emits them from the resolved media profile.
UPDATE public.label_templates
   SET body = regexp_replace(regexp_replace(body, E'\\^PW\\d+\\n?', '', 'g'), E'\\^LL\\d+\\n?', '', 'g')
 WHERE engine = 'zpl'
   AND (body LIKE '%^PW%' OR body LIKE '%^LL%');
