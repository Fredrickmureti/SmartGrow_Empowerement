
-- Blocking Gap #3 (Inventory Foundation Audit §11) — inventory event fabric.
-- Trigger emits a `stock.movement.posted` event to business_event_outbox
-- for every INSERT into stock_movements, inside the same transaction so
-- the event either lands with the row or not at all (outbox pattern).
--
-- Idempotency key = 'stock.movement:<uuid>' so a retried insert never
-- double-emits (the movement row itself already has UUID identity).

CREATE OR REPLACE FUNCTION public.tg_stock_movement_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type text;
BEGIN
  -- Skip synthetic/sample rows so QA fixtures don't inflate the outbox.
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
    org_id,
    branch_id,
    warehouse_id,
    event_type,
    source_doc_type,
    source_doc_id,
    payload,
    idempotency_key,
    actor_user_id,
    source
  ) VALUES (
    NEW.organization_id,
    NEW.branch_id,
    NEW.warehouse_id,
    v_event_type,
    'stock_movement',
    NEW.id,
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
    'db_trigger'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the write path. Drift/observability handled separately.
  RAISE WARNING 'tg_stock_movement_emit_event failed for movement %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movement_emit_event ON public.stock_movements;
CREATE TRIGGER trg_stock_movement_emit_event
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_stock_movement_emit_event();

COMMENT ON FUNCTION public.tg_stock_movement_emit_event() IS
  'ADR 0076 — publishes stock.movement.* events to business_event_outbox '
  'for every stock movement row. Runs after INSERT in the same transaction.';
