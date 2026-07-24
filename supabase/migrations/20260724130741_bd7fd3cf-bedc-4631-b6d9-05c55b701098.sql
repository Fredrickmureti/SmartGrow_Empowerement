
-- Phase 2 — Seal the legal-order FSM at the database tier.
-- Any direct UPDATE that changes status from application/client code is
-- rejected. Canonical transition functions run SECURITY DEFINER as
-- 'postgres', which the guard recognizes as the sanctioned writer path.

CREATE OR REPLACE FUNCTION public._legal_order_fsm_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- SECURITY DEFINER functions owned by postgres execute with
    -- current_user = 'postgres'. PostgREST client calls execute as
    -- 'authenticated' or 'anon'.
    IF current_user <> 'postgres' AND current_user <> 'service_role' THEN
      RAISE EXCEPTION
        'LEGAL_ORDER_FSM_BYPASS: direct status change from % to % is forbidden; use garnishment_transition()',
        OLD.status, NEW.status
        USING ERRCODE = '42501', HINT = 'LEGAL_ORDER_FSM_BYPASS';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_orders_records_fsm_guard ON public.legal_orders_records;
CREATE TRIGGER trg_legal_orders_records_fsm_guard
  BEFORE UPDATE OF status ON public.legal_orders_records
  FOR EACH ROW EXECUTE FUNCTION public._legal_order_fsm_guard();

COMMENT ON FUNCTION public._legal_order_fsm_guard() IS
  'ADR-0093 Phase 2: rejects direct status changes on legal_orders_records made outside a SECURITY DEFINER transition function.';

-- Publish a canonical lifecycle event so finance/audit/analytics can
-- subscribe. Fires from any accepted status change regardless of which
-- transition function performed it.
CREATE OR REPLACE FUNCTION public._legal_order_publish_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    BEGIN
      INSERT INTO public.business_event_outbox(
        topic, aggregate_type, aggregate_id, organization_id, payload, produced_by
      ) VALUES (
        'legal_order.status_changed',
        'legal_order',
        NEW.id,
        NEW.organization_id,
        jsonb_build_object(
          'from_status', OLD.status,
          'to_status',   NEW.status,
          'employee_id', NEW.employee_id,
          'recipient_id', NEW.recipient_id
        ),
        'payroll'
      );
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_legal_orders_records_publish_status ON public.legal_orders_records;
CREATE TRIGGER trg_legal_orders_records_publish_status
  AFTER UPDATE OF status ON public.legal_orders_records
  FOR EACH ROW EXECUTE FUNCTION public._legal_order_publish_status_event();
