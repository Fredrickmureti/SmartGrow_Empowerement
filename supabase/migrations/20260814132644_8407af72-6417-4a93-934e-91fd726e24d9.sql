-- ============================================================
-- ADR 0142 Phase 3 — movement ledger completeness
-- Items 2 (value/quantity guard), 3 (provenance), 4 (drift)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.stock_movement_source_types (
  reference_type text PRIMARY KEY,
  target_table   text,
  description    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.stock_movement_source_types TO authenticated;
GRANT ALL    ON public.stock_movement_source_types TO service_role;

ALTER TABLE public.stock_movement_source_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "source types are readable by authenticated users"
  ON public.stock_movement_source_types;
CREATE POLICY "source types are readable by authenticated users"
  ON public.stock_movement_source_types FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_stock_movement_source_types_updated_at
  ON public.stock_movement_source_types;
CREATE TRIGGER trg_stock_movement_source_types_updated_at
  BEFORE UPDATE ON public.stock_movement_source_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.stock_movement_source_types (reference_type, target_table, description) VALUES
  ('goods_receipt',           'goods_receipts',        'Goods receipt (GRN) confirmation'),
  ('goods_receipt_void',      'goods_receipts',        'Goods receipt reversal'),
  ('receiving_session',       NULL,                    'WMS receiving session posting'),
  ('invoice',                 'invoices',              'Invoice confirmation'),
  ('invoice_void',            'invoices',              'Invoice void / stock restore'),
  ('delivery_note',           'delivery_notes',        'Delivery note completion'),
  ('delivery_cancel',         'delivery_notes',        'Delivery note cancellation'),
  ('pos_transaction',         NULL,                    'Point-of-sale transaction'),
  ('sales_return',            NULL,                    'Approved sales return'),
  ('purchase_return',         NULL,                    'Purchase return dispatch'),
  ('return_to_vendor',        NULL,                    'Return-to-vendor disposition'),
  ('stock_transfer',          'stock_transfers',       'Inter-warehouse transfer'),
  ('inventory_adjustment',    NULL,                    'Authorized inventory adjustment'),
  ('stock_adjustment',        NULL,                    'Authorized inventory adjustment (legacy alias)'),
  ('physical_count',          NULL,                    'Physical count variance posting'),
  ('physical_count_reversal', NULL,                    'Physical count supersede / reversal'),
  ('lot_quarantine',          NULL,                    'Lot quarantine hold or release'),
  ('landed_cost_voucher',     NULL,                    'Landed cost revaluation (value only)'),
  ('wms_lpn',                 NULL,                    'License plate move / dispatch / receive'),
  ('wms_qc_inspection',       NULL,                    'Quality inspection disposition'),
  ('wms_replen_task',         NULL,                    'Replenishment task completion'),
  ('wms_replen_order',        NULL,                    'Replenishment order'),
  ('wms_return_order',        NULL,                    'WMS return order disposition'),
  ('stock_movement_reversal', 'stock_movements',       'Compensating reversal of an earlier movement'),
  ('opening_balance',         NULL,                    'Opening balance load'),
  ('data_migration',          NULL,                    'Historical data migration'),
  ('selftest',                NULL,                    'Internal self-test harness')
ON CONFLICT (reference_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_stock_movement_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pack_product uuid;
  v_src RECORD;
  v_exists boolean;
  v_provenance_exempt CONSTANT text[] := ARRAY['opening', 'migration'];
  v_value_only        CONSTANT text[] := ARRAY['landed_cost'];
BEGIN
  IF NEW.source_packaging_id IS NOT NULL AND NEW.product_id IS NOT NULL THEN
    SELECT product_id INTO v_pack_product
      FROM public.product_packaging WHERE id = NEW.source_packaging_id;
    IF v_pack_product IS NOT NULL AND v_pack_product <> NEW.product_id THEN
      RAISE EXCEPTION 'source_packaging_id % belongs to product %, movement product is %',
        NEW.source_packaging_id, v_pack_product, NEW.product_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.movement_type = ANY (v_value_only) THEN
    IF COALESCE(NEW.quantity, 0) <> 0 THEN
      RAISE EXCEPTION
        'INVENTORY_VALUE_ONLY_MOVEMENT: movement_type % is value-only and must carry quantity 0, got %',
        NEW.movement_type, NEW.quantity USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.movement_type <> 'migration' THEN
    IF COALESCE(NEW.quantity, 0) = 0 THEN
      RAISE EXCEPTION
        'INVENTORY_EMPTY_MOVEMENT: movement_type % must move a non-zero quantity',
        NEW.movement_type USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT (NEW.movement_type = ANY (v_provenance_exempt)) THEN
    IF NEW.reference_type IS NULL OR btrim(NEW.reference_type) = '' THEN
      RAISE EXCEPTION
        'INVENTORY_MOVEMENT_NO_PROVENANCE: reference_type is required for movement_type %',
        NEW.movement_type USING ERRCODE = '23502';
    END IF;
    IF NEW.reference_id IS NULL THEN
      RAISE EXCEPTION
        'INVENTORY_MOVEMENT_NO_PROVENANCE: reference_id is required for reference_type %',
        NEW.reference_type USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_src FROM public.stock_movement_source_types
     WHERE reference_type = NEW.reference_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'INVENTORY_UNKNOWN_SOURCE_TYPE: reference_type % is not registered in stock_movement_source_types',
        NEW.reference_type USING ERRCODE = '23514';
    END IF;

    IF v_src.target_table IS NOT NULL THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', v_src.target_table
      ) INTO v_exists USING NEW.reference_id;
      IF NOT v_exists THEN
        RAISE EXCEPTION
          'INVENTORY_DANGLING_PROVENANCE: % % does not exist in public.%',
          NEW.reference_type, NEW.reference_id, v_src.target_table USING ERRCODE = '23503';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_stock_movement_provenance ON public.stock_movements;
DROP TRIGGER IF EXISTS trg_enforce_stock_movement_integrity ON public.stock_movements;
CREATE TRIGGER trg_enforce_stock_movement_integrity
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stock_movement_integrity();

-- ---------- Item 4: four-way drift detection ----------
DROP FUNCTION IF EXISTS public.check_stock_quant_drift(uuid);

CREATE FUNCTION public.check_stock_quant_drift(_business_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(
  scope              text,
  warehouse_id       uuid,
  product_id         uuid,
  lot_number         text,
  quant_qty          numeric,
  projected_qty      numeric,
  drift              numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH quant_by_wh AS (
    SELECT l.warehouse_id AS wh, q.product_id AS pid, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY l.warehouse_id, q.product_id
  ),
  quant_by_lot AS (
    SELECT l.warehouse_id AS wh, q.product_id AS pid, q.lot_number AS lot, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE q.lot_number IS NOT NULL
       AND (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY l.warehouse_id, q.product_id, q.lot_number
  ),
  quant_by_product AS (
    SELECT q.product_id AS pid, SUM(q.quantity) AS qty
      FROM public.stock_quants q
      JOIN public.stock_locations l ON l.id = q.location_id
      JOIN public.warehouses w ON w.id = l.warehouse_id
     WHERE (_business_id IS NULL OR w.business_id = _business_id)
       AND public.user_can_access_business(auth.uid(), w.business_id)
     GROUP BY q.product_id
  ),
  lot_projection AS (
    SELECT wsl.warehouse_id AS wh, wsl.product_id AS pid,
           sl.lot_number AS lot, SUM(wsl.quantity) AS qty,
           w.business_id AS biz
      FROM public.warehouse_stock_lots wsl
      JOIN public.stock_lots sl ON sl.id = wsl.lot_id
      JOIN public.warehouses w ON w.id = wsl.warehouse_id
     GROUP BY wsl.warehouse_id, wsl.product_id, sl.lot_number, w.business_id
  )
  SELECT 'warehouse_stock'::text, ws.warehouse_id, ws.product_id, NULL::text,
         COALESCE(qw.qty, 0), ws.quantity, COALESCE(qw.qty, 0) - ws.quantity
    FROM public.warehouse_stock ws
    JOIN public.warehouses w ON w.id = ws.warehouse_id
    LEFT JOIN quant_by_wh qw ON qw.wh = ws.warehouse_id AND qw.pid = ws.product_id
   WHERE (_business_id IS NULL OR w.business_id = _business_id)
     AND public.user_can_access_business(auth.uid(), w.business_id)
     AND COALESCE(qw.qty, 0) <> ws.quantity

  UNION ALL
  SELECT 'warehouse_stock_lots'::text, lp.wh, lp.pid, lp.lot,
         COALESCE(ql.qty, 0), lp.qty, COALESCE(ql.qty, 0) - lp.qty
    FROM lot_projection lp
    LEFT JOIN quant_by_lot ql
      ON ql.wh = lp.wh AND ql.pid = lp.pid AND ql.lot = lp.lot
   WHERE (_business_id IS NULL OR lp.biz = _business_id)
     AND public.user_can_access_business(auth.uid(), lp.biz)
     AND COALESCE(ql.qty, 0) <> lp.qty

  UNION ALL
  SELECT 'products.stock_quantity'::text, NULL::uuid, p.id, NULL::text,
         COALESCE(qp.qty, 0), COALESCE(p.stock_quantity, 0),
         COALESCE(qp.qty, 0) - COALESCE(p.stock_quantity, 0)
    FROM public.products p
    LEFT JOIN quant_by_product qp ON qp.pid = p.id
   WHERE (_business_id IS NULL OR p.business_id = _business_id)
     AND public.user_can_access_business(auth.uid(), p.business_id)
     AND COALESCE(qp.qty, 0) <> COALESCE(p.stock_quantity, 0)
$function$;

GRANT EXECUTE ON FUNCTION public.check_stock_quant_drift(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_stock_quant_drift(uuid) TO service_role;