
-- ============================================================
-- POS Architecture · Batch S0
-- Freeze the business_event_outbox `source` drift surface.
-- Ref: .lovable/plan.md §5 S0, ADR 0082, docs/audit/pos-transaction-lifecycle-canonical.md
-- ============================================================

-- 1. New strict domain type. This is the single source of truth for
--    every business_event_outbox.source value going forward. Adding a
--    new domain is an explicit, reviewable DDL change.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'event_source_domain' AND n.nspname = 'public'
  ) THEN
    CREATE DOMAIN public.event_source_domain AS text
      CHECK (
        VALUE IN (
          'pos','finance','accounting','cash_management','statement',
          'manual','system','trigger',
          'procurement','purchasing','sales','crm','hr','payroll',
          'inventory','warehouse'
        )
      );
  END IF;
END$$;

-- 2. Retire the old free-text CHECK and pin the column to the domain.
--    All existing values (pos/inventory/system/trigger) already satisfy
--    the new domain, so the USING cast cannot fail.
ALTER TABLE public.business_event_outbox
  DROP CONSTRAINT IF EXISTS business_event_outbox_source_check;

ALTER TABLE public.business_event_outbox
  ALTER COLUMN source TYPE public.event_source_domain
  USING source::public.event_source_domain;

-- 3. Rewrite emitters whose source literal was invalid. Each function
--    now declares the real owning domain — never a table name, never a
--    call-site tag, never 'db_trigger'.

-- 3a. Client-facing RPC ingress (product.import.*, stock.*) → 'inventory'.
CREATE OR REPLACE FUNCTION public.emit_business_event(
  p_org_id uuid, p_business_id uuid, p_event_type text,
  p_source_doc_type text, p_source_doc_id uuid, p_idempotency_key text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_uid uuid := auth.uid();
  v_source public.event_source_domain;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'emit_business_event: authentication required';
  END IF;

  IF NOT (
    p_event_type LIKE 'product.import.%'
    OR p_event_type LIKE 'stock.%'
  ) THEN
    RAISE EXCEPTION 'emit_business_event: event_type % is not whitelisted', p_event_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid
      AND uba.business_id = COALESCE(p_business_id, p_org_id)
  ) THEN
    RAISE EXCEPTION 'emit_business_event: caller is not a member of the workspace';
  END IF;

  -- Domain routed from the event_type prefix. Both branches produce a
  -- value in the event_source_domain allow-list.
  v_source := CASE
    WHEN p_event_type LIKE 'stock.%' THEN 'inventory'
    ELSE 'inventory'  -- product.import.* is inventory-owned catalog data
  END::public.event_source_domain;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source
  ) VALUES (
    p_org_id, p_branch_id, p_warehouse_id, p_event_type,
    p_source_doc_type, p_source_doc_id,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('business_id', p_business_id),
    p_idempotency_key, v_uid, v_source
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- 3b. Card settlement close is a cash-management event.
CREATE OR REPLACE FUNCTION public.pos_close_card_settlement(
  p_settlement_id uuid, p_actual_amount numeric, p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row      public.pos_card_settlements%ROWTYPE;
  v_expected NUMERIC;
  v_variance NUMERIC;
BEGIN
  SELECT * INTO v_row FROM public.pos_card_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement % not found', p_settlement_id;
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'settlement % is % — only open batches can be closed', p_settlement_id, v_row.status;
  END IF;

  IF NOT (
       public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PRIVILEGE: only admins/managers can close card settlements';
  END IF;

  SELECT COALESCE(SUM(net),0) INTO v_expected
  FROM public.pos_card_settlement_lines
  WHERE settlement_id = p_settlement_id;

  v_variance := p_actual_amount - v_expected;

  UPDATE public.pos_card_settlements
     SET status          = 'closed',
         closed_at       = now(),
         closed_by       = auth.uid(),
         expected_amount = v_expected,
         actual_amount   = p_actual_amount,
         variance        = v_variance,
         notes           = COALESCE(p_notes, notes),
         updated_at      = now()
   WHERE id = p_settlement_id;

  INSERT INTO public.business_event_outbox(
    org_id, branch_id, event_type,
    source_doc_type, source_doc_id, payload,
    idempotency_key, source
  ) VALUES (
    v_row.organization_id, v_row.branch_id, 'settlement.card.closed',
    'pos_card_settlement', p_settlement_id,
    jsonb_build_object(
      'settlement_id',    p_settlement_id,
      'business_id',      v_row.business_id,
      'branch_id',        v_row.branch_id,
      'provider_key',     v_row.provider_key,
      'expected_amount',  v_expected,
      'actual_amount',    p_actual_amount,
      'variance',         v_variance,
      'batch_date',       v_row.batch_date,
      'closed_by',        auth.uid()
    ),
    'pos_card_settlement_close:' || p_settlement_id::text,
    'cash_management'
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'settlement_id',   p_settlement_id,
    'expected_amount', v_expected,
    'actual_amount',   p_actual_amount,
    'variance',        v_variance,
    'status',          'closed'
  );
END;
$function$;

-- 3c. Warehouse / inventory triggers that were tagging themselves 'db_trigger'.
--     Retag to the real owning domain.
CREATE OR REPLACE FUNCTION public.tg_wms_lpn_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_moved boolean := false;
  v_sealed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_moved := (NEW.current_location_id IS DISTINCT FROM OLD.current_location_id);
    v_sealed := (OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL);
  END IF;

  IF v_moved THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'warehouse.plate.moved', 'wms_license_plate', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'code', NEW.code,
        'from_location_id', OLD.current_location_id,
        'to_location_id', NEW.current_location_id,
        'lpn_type', NEW.lpn_type,
        'status', NEW.status
      ),
      'wms.plate.move:' || NEW.id::text || ':' || extract(epoch from now())::text,
      NULL, 'warehouse'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  IF v_sealed THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'warehouse.plate.sealed', 'wms_license_plate', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'code', NEW.code,
        'sealed_at', NEW.sealed_at,
        'current_location_id', NEW.current_location_id
      ),
      'wms.plate.seal:' || NEW.id::text,
      NULL, 'warehouse'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_wms_lpn_emit_event failed for lpn %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_wms_task_emit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE NEW.state
    WHEN 'assigned'    THEN 'warehouse.task.assigned'
    WHEN 'in_progress' THEN 'warehouse.task.started'
    WHEN 'done'        THEN 'warehouse.task.completed'
    WHEN 'cancelled'   THEN 'warehouse.task.cancelled'
    ELSE NULL
  END;

  IF v_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, warehouse_id,
    event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  ) VALUES (
    NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
    v_event_type, 'wms_task', NEW.id,
    jsonb_build_object(
      'business_id', NEW.business_id,
      'task_type', NEW.task_type,
      'state', NEW.state,
      'priority', NEW.priority,
      'assignee_user_id', NEW.assignee_user_id,
      'source_doc_type', NEW.source_doc_type,
      'source_doc_id', NEW.source_doc_id,
      'source_location_id', NEW.source_location_id,
      'destination_location_id', NEW.destination_location_id,
      'product_id', NEW.product_id,
      'lot_number', NEW.lot_number,
      'lpn_id', NEW.lpn_id,
      'quantity', NEW.quantity,
      'started_at', NEW.started_at,
      'completed_at', NEW.completed_at
    ),
    'wms.task:' || NEW.id::text || ':' || NEW.state::text,
    NEW.assignee_user_id,
    'warehouse'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_wms_task_emit_event failed for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_physical_count_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text := NULL;
  v_key_suffix text := NULL;
BEGIN
  IF NEW.state = 'posted' AND (OLD.state IS DISTINCT FROM 'posted') THEN
    v_event := 'stock.count.completed';
    v_key_suffix := 'posted';
  ELSIF NEW.state = 'cancelled' AND (OLD.state IS DISTINCT FROM 'cancelled') THEN
    v_event := 'stock.count.cancelled';
    v_key_suffix := 'cancelled';
  END IF;

  IF v_event IS NOT NULL THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      v_event, 'physical_count', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'count_number', NEW.count_number,
        'count_type', NEW.count_type,
        'warehouse_id', NEW.warehouse_id,
        'state', NEW.state,
        'posted_journal_entry_id', NEW.posted_journal_entry_id,
        'posted_adjustment_ids', NEW.posted_adjustment_ids,
        'cancellation_reason', NEW.cancellation_reason
      ),
      'stock.count:' || NEW.id::text || ':' || v_key_suffix,
      COALESCE(NEW.posted_by, NEW.cancelled_by, NEW.approved_by, NEW.created_by),
      'inventory'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_physical_count_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_stock_transfer_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event text := NULL;
  v_key_suffix text := NULL;
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    v_event := 'stock.transfer.approved';
    v_key_suffix := 'approved';
  ELSIF NEW.status IN ('completed', 'received') AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    v_event := 'stock.transfer.completed';
    v_key_suffix := 'completed';
  END IF;

  IF v_event IS NOT NULL THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.from_branch_id, NEW.from_warehouse_id,
      v_event, 'stock_transfer', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'transfer_number', NEW.transfer_number,
        'from_warehouse_id', NEW.from_warehouse_id,
        'to_warehouse_id', NEW.to_warehouse_id,
        'from_branch_id', NEW.from_branch_id,
        'to_branch_id', NEW.to_branch_id,
        'status', NEW.status,
        'transfer_date', NEW.transfer_date
      ),
      'stock.transfer:' || NEW.id::text || ':' || v_key_suffix,
      COALESCE(NEW.approved_by, NEW.completed_by, NEW.requested_by),
      'inventory'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_stock_transfer_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;
