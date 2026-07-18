
-- ============================================================
-- Batch T7 · POS Transaction Engine — Business event outbox
-- ============================================================
-- Downstream consumers (finance, inventory replication, analytics)
-- need to react to POS activity without polling. Emit two events
-- into business_event_outbox and let existing consumers pick them
-- up. Payload carries enough for a consumer to run without
-- re-reading the source table, and includes the source ID for
-- consumers that prefer to fetch full detail.

-- 1) Register topics ------------------------------------------
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description)
VALUES
  ('pos.sale.committed', 'sales',
   ARRAY['finance','inventory','analytics','crm'],
   'A POS sale or return finished successfully (committed to pos_transactions.status=completed).'),
  ('inventory.movement.recorded', 'inventory',
   ARRAY['finance','analytics','replication'],
   'A stock_movements row was written (any source). Payload includes movement_type + qty so consumers can filter.')
ON CONFLICT (topic_prefix) DO UPDATE
  SET consumer_domains = EXCLUDED.consumer_domains,
      description = EXCLUDED.description,
      updated_at = now();

-- 2) pos_transactions → pos.sale.committed --------------------
CREATE OR REPLACE FUNCTION public.trg_pos_transaction_emit_event_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status <> 'completed' THEN RETURN NULL; END IF;
  IF NEW.transaction_type NOT IN ('sale','return') THEN RETURN NULL; END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, 'pos.sale.committed',
    'pos_transaction', NEW.id,
    jsonb_build_object(
      'transaction_id', NEW.id,
      'transaction_number', NEW.transaction_number,
      'transaction_type', NEW.transaction_type,
      'organization_id', NEW.organization_id,
      'business_id', NEW.business_id,
      'branch_id', NEW.branch_id,
      'register_id', NEW.register_id,
      'shift_id', NEW.shift_id,
      'cashier_id', NEW.cashier_id,
      'customer_id', NEW.customer_id,
      'subtotal', NEW.subtotal,
      'tax_amount', NEW.tax_amount,
      'discount_amount', NEW.discount_amount,
      'total', NEW.total,
      'tip_amount', COALESCE(NEW.tip_amount, 0),
      'payment_status', NEW.payment_status,
      'journal_entry_id', NEW.journal_entry_id,
      'completed_at', NEW.completed_at,
      'original_transaction_id', NEW.original_transaction_id
    ),
    'pending',
    'pos.sale.committed:' || NEW.id::text,
    COALESCE(NEW.cashier_id, NEW.created_by),
    'pos_transactions'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_pos_transaction_emit_event ON public.pos_transactions;
CREATE TRIGGER trg_pos_transaction_emit_event
AFTER INSERT ON public.pos_transactions
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_transaction_emit_event_fn();

-- 3) stock_movements → inventory.movement.recorded ------------
-- Filter to POS-originated movement types so we don't flood the
-- outbox with every transfer / receipt row. Other domains can add
-- their own emitters (or widen this filter) later.
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
    'stock_movements'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_stock_movement_emit_event ON public.stock_movements;
CREATE TRIGGER trg_stock_movement_emit_event
AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.trg_stock_movement_emit_event_fn();
