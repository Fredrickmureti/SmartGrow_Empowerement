-- Fix two phantom-column bugs blocking org data reset
-- 1) pos_split_bill_items uses portion_id (NOT split_bill_id)
-- 2) stock_adjustment_items uses adjustment_id (NOT stock_adjustment_id)

CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  -- pos_transaction_item_modifiers (child of pos_transaction_items)
  WITH d AS (DELETE FROM pos_transaction_item_modifiers
              WHERE transaction_item_id IN (
                SELECT pti.id FROM pos_transaction_items pti
                JOIN pos_transactions pt ON pt.id = pti.transaction_id
                WHERE pt.organization_id = org_id) RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_item_modifiers', n);

  WITH d AS (DELETE FROM pos_transaction_items
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_items', n);

  WITH d AS (DELETE FROM pos_transaction_payments
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transaction_payments', n);

  WITH d AS (DELETE FROM pos_kitchen_orders
              WHERE transaction_id IN (SELECT id FROM pos_transactions WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_kitchen_orders', n);

  -- FIX: pos_split_bill_items references portions, not bills directly
  WITH d AS (DELETE FROM pos_split_bill_items
              WHERE portion_id IN (
                SELECT p.id FROM pos_split_bill_portions p
                JOIN pos_split_bills b ON b.id = p.split_bill_id
                WHERE b.organization_id = org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bill_items', n);

  WITH d AS (DELETE FROM pos_split_bill_portions
              WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bill_portions', n);

  WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_split_bills', n);
  WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_held_transactions', n);
  WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_gift_card_transactions', n);
  WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_transactions', n);
  WITH d AS (DELETE FROM pos_table_transfers WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_table_transfers', n);
  WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_table_sessions', n);
  WITH d AS (DELETE FROM pos_cash_movements
              WHERE shift_id IN (SELECT id FROM pos_shifts WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_cash_movements', n);
  WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_shifts', n);
  WITH d AS (DELETE FROM pos_daily_summary WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('pos_daily_summary', n);
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_module__inventory(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  WITH d AS (DELETE FROM stock_movements WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_movements', n);

  -- FIX: column is adjustment_id, not stock_adjustment_id
  WITH d AS (DELETE FROM stock_adjustment_items
              WHERE adjustment_id IN (SELECT id FROM stock_adjustments WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustment_items', n);

  WITH d AS (DELETE FROM stock_adjustments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('stock_adjustments', n);
  WITH d AS (DELETE FROM goods_receipt_items
              WHERE goods_receipt_id IN (SELECT id FROM goods_receipts WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipt_items', n);
  WITH d AS (DELETE FROM goods_receipts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('goods_receipts', n);
  WITH d AS (DELETE FROM backorders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('backorders', n);
  WITH d AS (DELETE FROM replenishment_logs WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('replenishment_logs', n);
  RETURN v;
END;
$function$;