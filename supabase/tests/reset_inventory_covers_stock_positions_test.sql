-- Regression guard (2026-07-31): "Wipe all transactional data" must clear
-- every stock-position surface that holds a RESTRICT/NO ACTION product FK.
-- Leaving stock_quants (or serials / QC inspections / receiving
-- discrepancies / inbound shipment lines) behind makes products
-- undeletable afterwards — PostgREST returns 409 Conflict.

DO $$
DECLARE
  v_def text;
  t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reset_module__inventory';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reset_module__inventory is missing';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'stock_quants',
    'stock_serials',
    'wms_qc_inspections',
    'goods_receipt_discrepancies',
    'inbound_shipment_items',
    'inbound_shipments',
    'warehouse_stock',
    'warehouse_stock_lots',
    'stock_lots',
    'stock_movements',
    'cost_layers'
  ] LOOP
    IF v_def !~ ('DELETE FROM public\.' || t || '\M') THEN
      RAISE EXCEPTION 'reset_module__inventory does not delete public.%', t;
    END IF;
  END LOOP;
END $$;
