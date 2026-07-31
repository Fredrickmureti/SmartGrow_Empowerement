CREATE OR REPLACE FUNCTION public.reset_module__inventory(org_id uuid, p_business_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb := '{}'::jsonb;
  n bigint;
  v_biz uuid := p_business_id;
BEGIN
  IF coalesce(current_setting('app.reset_in_progress', true), '') = '' THEN
    RAISE EXCEPTION 'reset_module__inventory must be called inside a governance teardown context'
      USING ERRCODE = '55000';
  END IF;

  WITH d AS (DELETE FROM public.physical_count_post_reconciliations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_post_reconciliations', n);

  WITH d AS (DELETE FROM public.physical_count_events
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_events', n);

  WITH d AS (DELETE FROM public.physical_count_freeze_movements
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_freeze_movements', n);

  WITH d AS (DELETE FROM public.physical_count_lines
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_lines', n);

  WITH d AS (DELETE FROM public.physical_counts
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_counts', n);

  WITH d AS (DELETE FROM public.physical_count_tolerance_policies
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('physical_count_tolerance_policies', n);

  WITH d AS (DELETE FROM public.cycle_count_schedules
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cycle_count_schedules', n);

  -- ── Residual stock-position surfaces (2026-07-31) ────────────────────
  -- These tables carry product_id FKs with ON DELETE RESTRICT/NO ACTION.
  -- If a wipe leaves them behind, products can never be deleted afterwards
  -- (PostgREST returns 409 Conflict). They must go with the rest of the
  -- transactional inventory state.
  WITH d AS (DELETE FROM public.wms_qc_inspections
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('wms_qc_inspections', n);

  WITH d AS (DELETE FROM public.goods_receipt_discrepancies
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipt_discrepancies', n);

  WITH d AS (DELETE FROM public.inbound_shipment_items
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('inbound_shipment_items', n);

  WITH d AS (DELETE FROM public.inbound_shipments
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('inbound_shipments', n);

  WITH d AS (DELETE FROM public.stock_serials
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_serials', n);

  WITH d AS (DELETE FROM public.stock_quants
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_quants', n);

  WITH d AS (DELETE FROM public.prescription_sale_links
              WHERE prescription_id IN (
                SELECT id FROM public.prescriptions
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('prescription_sale_links', n);

  WITH d AS (DELETE FROM public.prescriptions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('prescriptions', n);

  WITH d AS (DELETE FROM public.controlled_substance_register
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('controlled_substance_register', n);

  WITH d AS (DELETE FROM public.product_recall_items
              WHERE recall_id IN (
                SELECT id FROM public.product_recalls
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('product_recall_items', n);

  WITH d AS (DELETE FROM public.product_recalls
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('product_recalls', n);

  WITH d AS (DELETE FROM public.scan_events
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('scan_events', n);

  WITH d AS (DELETE FROM public.pos_stock_reservations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_stock_reservations', n);

  WITH d AS (DELETE FROM public.stock_reservations
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_reservations', n);

  WITH d AS (DELETE FROM public.stock_adjustment_backfill_log
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_backfill_log', n);

  WITH d AS (DELETE FROM public.stock_movements_orphans
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements_orphans', n);

  WITH d AS (DELETE FROM public.scrap_attachments
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('scrap_attachments', n);

  WITH d AS (DELETE FROM public.reconciliation_sessions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('reconciliation_sessions', n);

  WITH d AS (DELETE FROM public.cost_layer_consumptions
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cost_layer_consumptions', n);

  WITH d AS (DELETE FROM public.cost_layers
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('cost_layers', n);

  WITH d AS (DELETE FROM public.stock_movements
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements', n);

  WITH d AS (DELETE FROM public.stock_adjustment_items
              WHERE adjustment_id IN (
                SELECT id FROM public.stock_adjustments
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_items', n);

  WITH d AS (DELETE FROM public.stock_adjustments
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustments', n);

  WITH d AS (DELETE FROM public.stock_transfer_items
              WHERE transfer_id IN (
                SELECT id FROM public.stock_transfers
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_transfer_items', n);

  WITH d AS (DELETE FROM public.stock_transfers
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_transfers', n);

  WITH d AS (DELETE FROM public.goods_receipt_items
              WHERE goods_receipt_id IN (
                SELECT id FROM public.goods_receipts
                 WHERE organization_id = org_id
                   AND (v_biz IS NULL OR business_id = v_biz)
              )
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipt_items', n);

  WITH d AS (DELETE FROM public.goods_receipts
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipts', n);

  WITH d AS (DELETE FROM public.backorders
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('backorders', n);

  WITH d AS (DELETE FROM public.replenishment_logs
              WHERE organization_id = org_id
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('replenishment_logs', n);

  WITH d AS (DELETE FROM public.lot_quarantine
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('lot_quarantine', n);

  WITH d AS (DELETE FROM public.warehouse_stock_lots
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('warehouse_stock_lots', n);

  WITH d AS (DELETE FROM public.warehouse_stock
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('warehouse_stock', n);

  WITH d AS (DELETE FROM public.stock_lots
              WHERE organization_id = org_id
                AND (v_biz IS NULL OR business_id = v_biz)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_lots', n);

  RETURN v;
END;
$function$;

-- One-off repair: clear stock-position rows orphaned by earlier wipes
-- (no stock_movements / warehouse_stock remain for these organizations).
DELETE FROM public.stock_quants q
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_movements sm WHERE sm.organization_id = q.organization_id
)
AND NOT EXISTS (
  SELECT 1 FROM public.warehouse_stock ws WHERE ws.organization_id = q.organization_id
);