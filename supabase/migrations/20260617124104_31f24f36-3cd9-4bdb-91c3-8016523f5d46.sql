
-- Track 1 — Domain Event Bus + Hardware Outbox foundation

-- 1. business_event_outbox: durable record of every domain event
--    that may need to drive hardware, notifications, prints, or
--    downstream side-effects. Populated by triggers on source tables
--    so a UI crash cannot lose the event.

CREATE TYPE public.business_event_status AS ENUM (
  'pending', 'running', 'succeeded', 'failed', 'skipped'
);

CREATE TABLE public.business_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  branch_id uuid NULL,
  warehouse_id uuid NULL,
  event_type text NOT NULL,
  source_doc_type text NOT NULL,
  source_doc_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.business_event_status NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text NULL,
  idempotency_key text NOT NULL,
  actor_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX business_event_outbox_pending_idx
  ON public.business_event_outbox (org_id, status, created_at)
  WHERE status IN ('pending','running','failed');

CREATE INDEX business_event_outbox_source_idx
  ON public.business_event_outbox (source_doc_type, source_doc_id);

GRANT SELECT, INSERT, UPDATE ON public.business_event_outbox TO authenticated;
GRANT ALL ON public.business_event_outbox TO service_role;

ALTER TABLE public.business_event_outbox ENABLE ROW LEVEL SECURITY;

-- Org-scoped read: any authenticated user with access to the org sees the outbox.
CREATE POLICY business_event_outbox_org_read
  ON public.business_event_outbox FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = business_event_outbox.org_id
    )
  );

-- Writes from server-side triggers / service role only; deny direct
-- INSERT/UPDATE from authenticated clients. Triggers run with table
-- owner privileges and bypass RLS, which is intentional.
CREATE POLICY business_event_outbox_no_client_write
  ON public.business_event_outbox FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY business_event_outbox_no_client_update
  ON public.business_event_outbox FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_business_event_outbox_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status IN ('succeeded','failed','skipped') AND OLD.status NOT IN ('succeeded','failed','skipped') THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER business_event_outbox_touch
  BEFORE UPDATE ON public.business_event_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_business_event_outbox_touch();

-- 2. Helper to publish a domain event idempotently from any trigger.
CREATE OR REPLACE FUNCTION public.publish_business_event(
  p_org_id uuid,
  p_branch_id uuid,
  p_warehouse_id uuid,
  p_event_type text,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_payload jsonb,
  p_idempotency_key text,
  p_actor_user_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id
  ) VALUES (
    p_org_id, p_branch_id, p_warehouse_id, p_event_type,
    p_source_doc_type, p_source_doc_id, COALESCE(p_payload, '{}'::jsonb),
    p_idempotency_key, p_actor_user_id
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_business_event(uuid,uuid,uuid,text,text,uuid,jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_business_event(uuid,uuid,uuid,text,text,uuid,jsonb,text,uuid) TO authenticated, service_role;

-- 3. Augment hardware_exec_log with source-doc + outbox linkage so every
--    hardware call is traceable back to the business event that caused it.
ALTER TABLE public.hardware_exec_log
  ADD COLUMN IF NOT EXISTS source_doc_type text NULL,
  ADD COLUMN IF NOT EXISTS source_doc_id   uuid NULL,
  ADD COLUMN IF NOT EXISTS business_event_id uuid NULL
    REFERENCES public.business_event_outbox(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_reprint boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reprint_reason text NULL;

CREATE INDEX IF NOT EXISTS hardware_exec_log_source_doc_idx
  ON public.hardware_exec_log (source_doc_type, source_doc_id);

CREATE INDEX IF NOT EXISTS hardware_exec_log_business_event_idx
  ON public.hardware_exec_log (business_event_id);

-- 4. Wire after-commit triggers on the source tables that should emit events.
--    We start with the highest-value ones; the rest land in Tracks 2/3/4.

-- Goods Receipt posted
CREATE OR REPLACE FUNCTION public.tg_goods_receipt_emit_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.status = 'posted' AND (OLD.status IS DISTINCT FROM 'posted') THEN
    SELECT po.business_id INTO v_org
    FROM public.purchase_orders po WHERE po.id = NEW.purchase_order_id;

    IF v_org IS NOT NULL THEN
      PERFORM public.publish_business_event(
        v_org,
        NEW.branch_id,
        NEW.warehouse_id,
        'goods_receipt.posted',
        'goods_receipt',
        NEW.id,
        jsonb_build_object('grn_id', NEW.id, 'purchase_order_id', NEW.purchase_order_id),
        'grn-posted:' || NEW.id::text,
        auth.uid()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS goods_receipts_emit_posted ON public.goods_receipts;
CREATE TRIGGER goods_receipts_emit_posted
  AFTER INSERT OR UPDATE OF status ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.tg_goods_receipt_emit_posted();

-- Stock transfer dispatch + receipt
CREATE OR REPLACE FUNCTION public.tg_stock_transfer_emit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'in_transit' AND (OLD.status IS DISTINCT FROM 'in_transit') THEN
    PERFORM public.publish_business_event(
      NEW.business_id, NEW.from_branch_id, NEW.from_warehouse_id,
      'stock_transfer.dispatched', 'stock_transfer', NEW.id,
      jsonb_build_object('transfer_id', NEW.id,
        'from_warehouse_id', NEW.from_warehouse_id,
        'to_warehouse_id', NEW.to_warehouse_id),
      'st-dispatched:' || NEW.id::text,
      auth.uid()
    );
  ELSIF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    PERFORM public.publish_business_event(
      NEW.business_id, NEW.to_branch_id, NEW.to_warehouse_id,
      'stock_transfer.received', 'stock_transfer', NEW.id,
      jsonb_build_object('transfer_id', NEW.id),
      'st-received:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_transfers_emit ON public.stock_transfers;
CREATE TRIGGER stock_transfers_emit
  AFTER UPDATE OF status ON public.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.tg_stock_transfer_emit();

-- Delivery note dispatched
CREATE OR REPLACE FUNCTION public.tg_delivery_note_emit_dispatched()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('dispatched','in_transit') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.publish_business_event(
      NEW.business_id, NEW.branch_id, NEW.warehouse_id,
      'delivery_note.dispatched', 'delivery_note', NEW.id,
      jsonb_build_object('delivery_note_id', NEW.id, 'invoice_id', NEW.invoice_id),
      'dn-dispatched:' || NEW.id::text,
      auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_notes_emit_dispatched ON public.delivery_notes;
CREATE TRIGGER delivery_notes_emit_dispatched
  AFTER UPDATE OF status ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_delivery_note_emit_dispatched();

-- Product created
CREATE OR REPLACE FUNCTION public.tg_product_emit_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.publish_business_event(
    NEW.business_id, NULL, NULL,
    'product.created', 'product', NEW.id,
    jsonb_build_object('product_id', NEW.id, 'sku', NEW.sku, 'name', NEW.name),
    'product-created:' || NEW.id::text,
    auth.uid()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_emit_created ON public.products;
CREATE TRIGGER products_emit_created
  AFTER INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_product_emit_created();

-- 5. RPC for the BusinessSaga worker to atomically claim the next pending row.
--    Uses FOR UPDATE SKIP LOCKED so multiple workers (one per host) cannot
--    grab the same row.
CREATE OR REPLACE FUNCTION public.claim_next_business_event(p_org_id uuid, p_limit int DEFAULT 1)
RETURNS SETOF public.business_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH cte AS (
    SELECT id FROM public.business_event_outbox
    WHERE org_id = p_org_id
      AND status IN ('pending','failed')
      AND attempts < 10
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.business_event_outbox o
  SET status = 'running', attempts = o.attempts + 1, updated_at = now()
  FROM cte
  WHERE o.id = cte.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_business_event(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_business_event(uuid,int) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_business_event(
  p_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.business_event_outbox
  SET status = CASE WHEN p_success THEN 'succeeded'::public.business_event_status
                    ELSE 'failed'::public.business_event_status END,
      last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
      updated_at = now()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_business_event(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_business_event(uuid,boolean,text) TO authenticated, service_role;
