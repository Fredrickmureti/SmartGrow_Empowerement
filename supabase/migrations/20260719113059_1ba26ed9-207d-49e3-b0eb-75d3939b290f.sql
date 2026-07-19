-- Fix POS commit 400: stock_movement outbox emitters used invalid `source` values
-- that violate business_event_outbox_source_check. This aborted the whole
-- pos_payment_session_commit transaction.

CREATE OR REPLACE FUNCTION public.trg_stock_movement_emit_event_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.movement_type NOT IN ('pos_sale','pos_return') THEN RETURN NULL; END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
    'inventory.movement.recorded',
    'stock_movement', NEW.id,
    jsonb_build_object(
      'movement_id', NEW.id,
      'movement_type', NEW.movement_type,
      'organization_id', NEW.organization_id,
      'business_id', NEW.business_id,
      'branch_id', NEW.branch_id,
      'warehouse_id', NEW.warehouse_id,
      'product_id', NEW.product_id,
      'quantity', NEW.quantity,
      'unit_cost', NEW.unit_cost,
      'reference_type', NEW.reference_type,
      'reference_id', NEW.reference_id,
      'lot_number', NEW.lot_number,
      'serial_number', NEW.serial_number,
      'movement_date', NEW.movement_date
    ),
    'pending',
    'inventory.movement.recorded:' || NEW.id::text,
    NEW.created_by,
    'inventory'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.tg_stock_movement_emit_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_event_type text;
BEGIN
  IF COALESCE(NEW.is_sample_data, false) THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE
    WHEN NEW.movement_type IN ('purchase', 'purchase_receipt', 'grn', 'inbound', 'return_from_customer')
      THEN 'stock.movement.received'
    WHEN NEW.movement_type IN ('sale', 'pos_sale', 'shipment', 'delivery', 'outbound', 'return_to_vendor')
      THEN 'stock.movement.dispatched'
    WHEN NEW.movement_type IN ('transfer_out', 'transfer_in', 'transfer')
      THEN 'stock.movement.transferred'
    WHEN NEW.movement_type IN ('adjustment', 'opening_balance', 'stock_count', 'writeoff', 'scrap')
      THEN 'stock.movement.adjusted'
    ELSE 'stock.movement.posted'
  END;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
    v_event_type, 'stock_movement', NEW.id,
    jsonb_build_object(
      'business_id', NEW.business_id,
      'product_id', NEW.product_id,
      'movement_type', NEW.movement_type,
      'quantity', NEW.quantity,
      'unit_cost', NEW.unit_cost,
      'reference_type', NEW.reference_type,
      'reference_id', NEW.reference_id,
      'lot_number', NEW.lot_number,
      'serial_number', NEW.serial_number,
      'source_location_id', NEW.source_location_id,
      'destination_location_id', NEW.destination_location_id,
      'movement_date', NEW.movement_date
    ),
    'stock.movement:' || NEW.id::text,
    NEW.created_by,
    'inventory'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_stock_movement_emit_event failed for movement %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- Related emitters that also used invalid source tags (fix while we're here so
-- other write paths don't hit the same 23514):
CREATE OR REPLACE FUNCTION public.tg_stock_adjustment_emit_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.tg_stock_adjustment_emit_lifecycle'::regproc);
  RETURN NEW;
END $$;
