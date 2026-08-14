-- =====================================================================
-- Inventory Foundation Wave · Phase 6 — Events: one emitter, complete topics
-- =====================================================================

-- 1) Movement → business class registry -------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_movement_event_classes (
  movement_type   text PRIMARY KEY,
  movement_class  text NOT NULL CHECK (movement_class IN
                    ('received','dispatched','transferred','adjusted','posted')),
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.inventory_movement_event_classes TO authenticated;
GRANT ALL    ON public.inventory_movement_event_classes TO service_role;
REVOKE ALL   ON public.inventory_movement_event_classes FROM anon;

ALTER TABLE public.inventory_movement_event_classes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "movement event classes readable" ON public.inventory_movement_event_classes;
CREATE POLICY "movement event classes readable"
  ON public.inventory_movement_event_classes
  FOR SELECT TO authenticated
  USING (true);

DROP TRIGGER IF EXISTS trg_inventory_movement_event_classes_touch ON public.inventory_movement_event_classes;
CREATE TRIGGER trg_inventory_movement_event_classes_touch
  BEFORE UPDATE ON public.inventory_movement_event_classes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.inventory_movement_event_classes (movement_type, movement_class, description) VALUES
  ('purchase',    'received',    'Supplier purchase into stock'),
  ('receipt',     'received',    'Goods receipt / inbound'),
  ('return_in',   'received',    'Customer return into stock'),
  ('pos_return',  'received',    'Point-of-sale return into stock'),
  ('opening',     'received',    'Opening balance load'),
  ('sale',        'dispatched',  'Sales issue'),
  ('pos_sale',    'dispatched',  'Point-of-sale issue'),
  ('delivery',    'dispatched',  'Delivery / shipment issue'),
  ('return_out',  'dispatched',  'Return to vendor'),
  ('transfer',    'transferred', 'Inter-warehouse or inter-location transfer'),
  ('adjustment',  'adjusted',    'Manual or system adjustment'),
  ('scrap',       'adjusted',    'Scrap / write-off'),
  ('count',       'adjusted',    'Physical count variance'),
  ('migration',   'adjusted',    'Data migration load'),
  ('landed_cost', 'posted',      'Value-only landed cost movement')
ON CONFLICT (movement_type) DO UPDATE
  SET movement_class = EXCLUDED.movement_class,
      description    = EXCLUDED.description,
      updated_at     = now();

-- 2) Topic registry ----------------------------------------------------
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES
  ('inventory.movement.recorded', 'inventory', ARRAY['finance','analytics','replication'],
   'A stock_movements row was written (any source). Payload carries movement_type, movement_class and quantity.', 'server'),
  ('inventory.lot.quarantined', 'inventory', ARRAY['quality','analytics'],
   'A lot was placed under quarantine.', 'server'),
  ('inventory.lot.released', 'inventory', ARRAY['quality','analytics'],
   'A quarantined lot was released back to available stock.', 'server'),
  ('inventory.lot.recall_opened', 'inventory', ARRAY['quality','sales','analytics'],
   'A product recall was opened.', 'server'),
  ('inventory.lot.recall_closed', 'inventory', ARRAY['quality','sales','analytics'],
   'A product recall was closed.', 'server'),
  ('inventory.serial.status_changed', 'inventory', ARRAY['analytics','service'],
   'A serialised unit changed lifecycle status.', 'server'),
  ('inventory.valuation.revalued', 'inventory', ARRAY['finance','analytics'],
   'A cost revaluation was applied to an inventory cost layer.', 'server'),
  ('inventory.valuation.revaluation_reversed', 'inventory', ARRAY['finance','analytics'],
   'A previously applied cost revaluation was reversed.', 'server')
ON CONFLICT (topic_prefix) DO UPDATE
  SET producer_domain  = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description      = EXCLUDED.description,
      handler_scope    = EXCLUDED.handler_scope,
      updated_at       = now();

-- 3) The single inventory emitter -------------------------------------
CREATE OR REPLACE FUNCTION public.emit_inventory_event(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_warehouse_id uuid,
  p_event_type text,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_payload jsonb,
  p_idempotency_key text,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope text;
  v_id uuid;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN NULL;  -- unscoped rows cannot be routed; nothing to publish
  END IF;

  SELECT t.handler_scope INTO v_scope
    FROM public.business_event_topics t
   WHERE t.topic_prefix = p_event_type;

  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_UNREGISTERED_EVENT_TOPIC: % is not registered in business_event_topics', p_event_type
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    status, idempotency_key, actor_user_id, source, handler_scope
  ) VALUES (
    p_org_id, p_branch_id, p_warehouse_id, p_event_type,
    p_source_doc_type, p_source_doc_id,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('business_id', p_business_id),
    'pending', p_idempotency_key, p_actor_user_id, 'inventory', v_scope
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.emit_inventory_event(uuid,uuid,uuid,uuid,text,text,uuid,jsonb,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_inventory_event(uuid,uuid,uuid,uuid,text,text,uuid,jsonb,text,uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.emit_inventory_event(uuid,uuid,uuid,uuid,text,text,uuid,jsonb,text,uuid) IS
  'Phase 6 — the only path by which the Inventory domain writes business_event_outbox. Routes handler_scope from business_event_topics.';

-- 4) Movement emitter: one trigger, every movement type ----------------
CREATE OR REPLACE FUNCTION public.tg_stock_movement_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_class text;
BEGIN
  IF COALESCE(NEW.is_sample_data, false) THEN
    RETURN NULL;
  END IF;

  SELECT c.movement_class INTO v_class
    FROM public.inventory_movement_event_classes c
   WHERE c.movement_type = NEW.movement_type;

  IF v_class IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_UNMAPPED_MOVEMENT_TOPIC: movement_type % has no row in inventory_movement_event_classes', NEW.movement_type
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.emit_inventory_event(
    NEW.organization_id,
    NEW.business_id,
    NEW.branch_id,
    NEW.warehouse_id,
    'inventory.movement.recorded',
    'stock_movement',
    NEW.id,
    jsonb_build_object(
      'movement_id',            NEW.id,
      'movement_type',          NEW.movement_type,
      'movement_class',         v_class,
      'product_id',             NEW.product_id,
      'quantity',               NEW.quantity,
      'signed_quantity',        public.stock_movement_signed_quantity(NEW.movement_type, NEW.quantity),
      'unit_cost',              NEW.unit_cost,
      'reference_type',         NEW.reference_type,
      'reference_id',           NEW.reference_id,
      'lot_number',             NEW.lot_number,
      'serial_number',          NEW.serial_number,
      'source_location_id',     NEW.source_location_id,
      'destination_location_id',NEW.destination_location_id,
      'reverses_movement_id',   NEW.reverses_movement_id,
      'movement_date',          NEW.movement_date
    ),
    'inventory.movement.recorded:' || NEW.id::text,
    NEW.created_by
  );

  RETURN NULL;
END;
$function$;

-- Collapse the two emitters into one.
DROP TRIGGER IF EXISTS trg_stock_movement_emit_event ON public.stock_movements;
DROP FUNCTION IF EXISTS public.trg_stock_movement_emit_event_fn() CASCADE;

CREATE TRIGGER trg_stock_movement_emit_event
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.tg_stock_movement_emit_event();

-- 5) Lot quarantine / release -----------------------------------------
CREATE OR REPLACE FUNCTION public.tg_lot_quarantine_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := CASE WHEN NEW.status = 'released'
                    THEN 'inventory.lot.released'
                    ELSE 'inventory.lot.quarantined' END;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event := CASE WHEN NEW.status = 'released'
                    THEN 'inventory.lot.released'
                    ELSE 'inventory.lot.quarantined' END;
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.emit_inventory_event(
    NEW.organization_id, NEW.business_id, NULL, NEW.warehouse_id,
    v_event, 'lot_quarantine', NEW.id,
    jsonb_build_object(
      'lot_id',     NEW.lot_id,
      'status',     NEW.status,
      'reason',     NEW.reason,
      'recall_id',  NEW.recall_id,
      'warehouse_id', NEW.warehouse_id
    ),
    v_event || ':' || NEW.id::text || ':' || NEW.status,
    COALESCE(NEW.released_by, NEW.authorised_by)
  );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_lot_quarantine_emit_event ON public.lot_quarantine;
CREATE TRIGGER trg_lot_quarantine_emit_event
  AFTER INSERT OR UPDATE OF status ON public.lot_quarantine
  FOR EACH ROW EXECUTE FUNCTION public.tg_lot_quarantine_emit_event();

-- 6) Recall lifecycle --------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_product_recall_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'inventory.lot.recall_opened';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('closed','completed','cancelled') THEN
    v_event := 'inventory.lot.recall_closed';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.emit_inventory_event(
    NEW.organization_id, NEW.business_id, NULL, NULL,
    v_event, 'product_recall', NEW.id,
    jsonb_build_object(
      'product_id',       NEW.product_id,
      'recall_reference', NEW.recall_reference,
      'severity',         NEW.severity,
      'status',           NEW.status,
      'reason',           NEW.reason
    ),
    v_event || ':' || NEW.id::text || ':' || NEW.status,
    NEW.initiated_by
  );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_product_recall_emit_event ON public.product_recalls;
CREATE TRIGGER trg_product_recall_emit_event
  AFTER INSERT OR UPDATE OF status ON public.product_recalls
  FOR EACH ROW EXECUTE FUNCTION public.tg_product_recall_emit_event();

-- 7) Serial lifecycle --------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_stock_serial_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  PERFORM public.emit_inventory_event(
    NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.current_warehouse_id,
    'inventory.serial.status_changed', 'stock_serial', NEW.id,
    jsonb_build_object(
      'serial_number',        NEW.serial_number,
      'product_id',           NEW.product_id,
      'lot_number',           NEW.lot_number,
      'previous_status',      OLD.status,
      'status',               NEW.status,
      'current_warehouse_id', NEW.current_warehouse_id,
      'current_location_id',  NEW.current_location_id,
      'last_movement_id',     NEW.last_movement_id
    ),
    'inventory.serial.status_changed:' || NEW.id::text || ':' || COALESCE(NEW.last_movement_id::text, NEW.status::text || ':' || extract(epoch from now())::bigint::text),
    NULL
  );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stock_serial_emit_event ON public.stock_serials;
CREATE TRIGGER trg_stock_serial_emit_event
  AFTER UPDATE OF status ON public.stock_serials
  FOR EACH ROW EXECUTE FUNCTION public.tg_stock_serial_emit_event();

-- 8) Valuation revaluation --------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_inventory_revaluation_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event := 'inventory.valuation.revalued';
  ELSIF NEW.reversed_at IS NOT NULL AND OLD.reversed_at IS NULL THEN
    v_event := 'inventory.valuation.revaluation_reversed';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.emit_inventory_event(
    NEW.organization_id, NEW.business_id, NULL, NEW.warehouse_id,
    v_event, 'inventory_cost_revaluation', NEW.id,
    jsonb_build_object(
      'layer_id',         NEW.layer_id,
      'product_id',       NEW.product_id,
      'warehouse_id',     NEW.warehouse_id,
      'source_type',      NEW.source_type,
      'source_id',        NEW.source_id,
      'amount_applied',   NEW.amount_applied,
      'unit_cost_before', NEW.unit_cost_before,
      'unit_cost_after',  NEW.unit_cost_after
    ),
    v_event || ':' || NEW.id::text,
    COALESCE(NEW.reversed_by, NEW.created_by)
  );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_inventory_revaluation_emit_event ON public.inventory_cost_revaluations;
CREATE TRIGGER trg_inventory_revaluation_emit_event
  AFTER INSERT OR UPDATE OF reversed_at ON public.inventory_cost_revaluations
  FOR EACH ROW EXECUTE FUNCTION public.tg_inventory_revaluation_emit_event();
