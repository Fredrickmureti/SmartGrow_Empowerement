
-- Session 8 · Priority B — non-movement stock lifecycle events.
-- Mirrors the ADR-0076 outbox pattern established by
-- tg_stock_movement_emit_event: SECURITY DEFINER, emits into
-- business_event_outbox in the same transaction, idempotent via
-- idempotency_key, and never breaks the write path.
--
-- Whitelist compliance: event types are all `stock.*` so
-- emit_business_event's RPC-level whitelist stays authoritative for the
-- client entry point; these triggers bypass the RPC because they
-- already run as the workspace-owner path (INSERT/UPDATE by an
-- authenticated member on a business-scoped row).

-- ---------- Stock adjustment posted ----------
CREATE OR REPLACE FUNCTION public.tg_stock_adjustment_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_sample_data, false) THEN
    RETURN NEW;
  END IF;

  -- Fire only on the transition to `approved` (auto-applied path) so a
  -- resave in the same terminal state cannot re-emit.
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'stock.adjustment.posted', 'stock_adjustment', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'adjustment_number', NEW.adjustment_number,
        'reason', NEW.reason,
        'adjustment_type', NEW.adjustment_type,
        'warehouse_id', NEW.warehouse_id,
        'approved_at', NEW.approved_at
      ),
      'stock.adjustment:' || NEW.id::text,
      COALESCE(NEW.approved_by, NEW.created_by),
      'db_trigger'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_stock_adjustment_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_adjustment_emit_lifecycle ON public.stock_adjustments;
CREATE TRIGGER trg_stock_adjustment_emit_lifecycle
  AFTER UPDATE ON public.stock_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_stock_adjustment_emit_lifecycle();

-- ---------- Stock transfer approved / completed ----------
CREATE OR REPLACE FUNCTION public.tg_stock_transfer_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      'db_trigger'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_stock_transfer_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_transfer_emit_lifecycle ON public.stock_transfers;
CREATE TRIGGER trg_stock_transfer_emit_lifecycle
  AFTER UPDATE ON public.stock_transfers
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_stock_transfer_emit_lifecycle();

-- ---------- Physical count posted / cancelled ----------
CREATE OR REPLACE FUNCTION public.tg_physical_count_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      'db_trigger'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_physical_count_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_physical_count_emit_lifecycle ON public.physical_counts;
CREATE TRIGGER trg_physical_count_emit_lifecycle
  AFTER UPDATE ON public.physical_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_physical_count_emit_lifecycle();

COMMENT ON FUNCTION public.tg_stock_adjustment_emit_lifecycle() IS
  'Session 8 Priority B — publishes stock.adjustment.posted to business_event_outbox.';
COMMENT ON FUNCTION public.tg_stock_transfer_emit_lifecycle() IS
  'Session 8 Priority B — publishes stock.transfer.{approved,completed} to business_event_outbox.';
COMMENT ON FUNCTION public.tg_physical_count_emit_lifecycle() IS
  'Session 8 Priority B — publishes stock.count.{completed,cancelled} to business_event_outbox.';
