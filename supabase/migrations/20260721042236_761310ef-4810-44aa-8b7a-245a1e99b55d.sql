
-- Extend seed_default_label_templates() to include asset / count / return
CREATE OR REPLACE FUNCTION public.seed_default_label_templates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.label_templates
    (org_id, branch_id, kind, template_key, name, engine, body,
     width_mm, height_mm, is_default, version, active, media_profile_id, geometry_mode)
  VALUES
    (NEW.id, NULL, 'product', 'product_label', 'Default product label', 'zpl',
     '^XA^CF0,{{cf:3.2mm}}^FO{{mm:3}},{{mm:2}}^FD{{name}}^FS'
     || '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:8}}^BCN,{{bh:10mm}},{{hri_flag}},N,N^FD{{barcode}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:22}}^FD{{sku_display}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'shelf', 'shelf_label', 'Default shelf-edge label', 'zpl',
     '^XA^CF0,{{cf:3.5mm}}^FO{{mm:3}},{{mm:2}}^FD{{name}}^FS'
     || '^CF0,{{cf:6mm}}^FO{{mm:3}},{{mm:8}}^FD{{price}}^FS'
     || '^BY{{by:0.3mm}},2,{{mm:18}}^BCN,{{bh:8mm}},N,N,N^FD{{barcode}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:28}}^FD{{sku_display}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'lot', 'lot_label', 'Default lot / batch label', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FD{{name}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FDLOT {{lot_number}}^FS'
     || '^FO{{mm:3}},{{mm:11}}^FDEXP {{expiry_date}}^FS'
     || '^BY{{by:0.3mm}},2,{{bh:9mm}}^FO{{mm:3}},{{mm:15}}^BCN,{{bh:9mm}},N,N,N^FD{{barcode}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:26}}^FD{{sku_display}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'bin', 'bin_label', 'Default bin / location label', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FD{{location_name}}^FS'
     || '^BY{{by:0.35mm}},2,{{bh:12mm}}^FO{{mm:3}},{{mm:7}}^BCN,{{bh:12mm}},Y,N,N^FD{{bin_code}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'receiving', 'receiving_label', 'Default receiving / GRN label', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FDGRN {{grn_number}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FD{{supplier_name}}^FS'
     || '^FO{{mm:3}},{{mm:11}}^FD{{name}}^FS'
     || '^BY{{by:0.3mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:15}}^BCN,{{bh:10mm}},Y,N,N^FD{{barcode}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'pallet', 'pallet_label', 'Default pallet label', 'zpl',
     '^XA^CF0,{{cf:4mm}}^FO{{mm:5}},{{mm:5}}^FDPALLET^FS'
     || '^BY{{by:0.5mm}},3,{{bh:25mm}}^FO{{mm:5}},{{mm:14}}^BCN,{{bh:25mm}},Y,N,N^FD{{pallet_id}}^FS'
     || '^CF0,{{cf:3mm}}^FO{{mm:5}},{{mm:50}}^FD{{warehouse_name}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'shipping', 'shipping_label', 'Default shipping label', 'zpl',
     '^XA^CF0,{{cf:3.5mm}}^FO{{mm:5}},{{mm:5}}^FDShip To:^FS'
     || '^CF0,{{cf:3mm}}^FO{{mm:5}},{{mm:11}}^FD{{ship_to_name}}^FS'
     || '^FO{{mm:5}},{{mm:16}}^FD{{ship_to_address_1}}^FS'
     || '^FO{{mm:5}},{{mm:21}}^FD{{ship_to_city}}^FS'
     || '^BY{{by:0.4mm}},2,{{bh:15mm}}^FO{{mm:5}},{{mm:30}}^BCN,{{bh:15mm}},Y,N,N^FD{{tracking_number}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'asset', 'asset_label', 'Default fixed-asset tag', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FD{{asset_name}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FDTAG {{asset_tag}}^FS'
     || '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:11}}^BCN,{{bh:10mm}},Y,N,N^FD{{asset_tag}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:24}}^FD{{location_name}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'count', 'count_label', 'Default cycle-count sheet label', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FDCOUNT {{count_number}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FD{{location_name}}^FS'
     || '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:11}}^BCN,{{bh:10mm}},Y,N,N^FD{{count_number}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm'),
    (NEW.id, NULL, 'return', 'return_label', 'Default return / RMA tag', 'zpl',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FDRMA {{rma_number}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FD{{customer_name}}^FS'
     || '^FO{{mm:3}},{{mm:11}}^FD{{name}}^FS'
     || '^BY{{by:0.3mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:15}}^BCN,{{bh:10mm}},Y,N,N^FD{{rma_number}}^FS^XZ',
     NULL, NULL, true, 1, true, NULL, 'mm')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_default_label_templates() IS
  'ADR-0087 + ADR-0088. Seeds ten canonical label templates on organization insert (product/shelf/lot/bin/receiving/pallet/shipping/asset/count/return). All bodies are media-agnostic and mm-authored; envelope + dot conversion happen at dispatch time.';

-- Backfill: existing orgs receive the three new default rows.
INSERT INTO public.label_templates
  (org_id, branch_id, kind, template_key, name, engine, body,
   width_mm, height_mm, is_default, version, active, media_profile_id, geometry_mode)
SELECT o.id, NULL, seeds.kind, seeds.template_key, seeds.tpl_name, 'zpl', seeds.body,
       NULL, NULL, true, 1, true, NULL, 'mm'
FROM public.organizations o
CROSS JOIN (
  VALUES
    ('asset', 'asset_label', 'Default fixed-asset tag',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FD{{asset_name}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FDTAG {{asset_tag}}^FS'
     || '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:11}}^BCN,{{bh:10mm}},Y,N,N^FD{{asset_tag}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:24}}^FD{{location_name}}^FS^XZ'),
    ('count', 'count_label', 'Default cycle-count sheet label',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FDCOUNT {{count_number}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FD{{location_name}}^FS'
     || '^BY{{by:0.33mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:11}}^BCN,{{bh:10mm}},Y,N,N^FD{{count_number}}^FS^XZ'),
    ('return', 'return_label', 'Default return / RMA tag',
     '^XA^CF0,{{cf:3mm}}^FO{{mm:3}},{{mm:2}}^FDRMA {{rma_number}}^FS'
     || '^CF0,{{cf:2.5mm}}^FO{{mm:3}},{{mm:7}}^FD{{customer_name}}^FS'
     || '^FO{{mm:3}},{{mm:11}}^FD{{name}}^FS'
     || '^BY{{by:0.3mm}},2,{{bh:10mm}}^FO{{mm:3}},{{mm:15}}^BCN,{{bh:10mm}},Y,N,N^FD{{rma_number}}^FS^XZ')
) AS seeds(kind, template_key, tpl_name, body)
WHERE NOT EXISTS (
  SELECT 1 FROM public.label_templates lt
  WHERE lt.org_id = o.id
    AND lt.template_key = seeds.template_key
    AND lt.is_default = true
    AND lt.branch_id IS NULL
);
