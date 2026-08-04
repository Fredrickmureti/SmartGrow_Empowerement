-- =====================================================================
-- Phase 4 — notification bridge.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.wms_exception_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  owner_role public.wms_exception_owner_role,
  exception_class public.wms_exception_class,
  min_severity smallint NOT NULL DEFAULT 1,
  notify_on_raise boolean NOT NULL DEFAULT true,
  notify_on_escalate boolean NOT NULL DEFAULT true,
  notify_on_resolve boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wms_exception_subscriptions_unique
  ON public.wms_exception_subscriptions (user_id, warehouse_id, owner_role, exception_class)
  NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS wms_exception_subscriptions_lookup
  ON public.wms_exception_subscriptions (warehouse_id, active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_exception_subscriptions TO authenticated;
GRANT ALL ON public.wms_exception_subscriptions TO service_role;
ALTER TABLE public.wms_exception_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own subscriptions" ON public.wms_exception_subscriptions;
CREATE POLICY "own subscriptions" ON public.wms_exception_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP TRIGGER IF EXISTS wms_exception_subscriptions_touch ON public.wms_exception_subscriptions;
CREATE TRIGGER wms_exception_subscriptions_touch
  BEFORE UPDATE ON public.wms_exception_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------------
-- Audience resolution + delivery.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_notify_exception(
  p_exception public.wms_exceptions,
  p_event text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid;
  v_title text;
  v_priority text;
  v_kind text := replace(p_exception.kind::text, '_', ' ');
BEGIN
  v_title := CASE p_event
    WHEN 'raised'    THEN initcap(v_kind)
    WHEN 'assigned'  THEN 'Assigned to you: ' || v_kind
    WHEN 'escalated' THEN format('Escalated (L%s): %s', COALESCE(p_exception.escalation_level,1), v_kind)
    WHEN 'resolved'  THEN 'Closed: ' || v_kind
    ELSE initcap(v_kind)
  END;

  v_priority := CASE
    WHEN p_event = 'escalated' OR p_exception.severity >= 4 THEN 'urgent'
    WHEN p_exception.severity = 3 THEN 'high'
    ELSE 'normal'
  END;

  FOR v_user IN
    SELECT DISTINCT u.user_id FROM (
      -- The assignee always hears about their own exception.
      SELECT p_exception.assigned_to AS user_id
       WHERE p_exception.assigned_to IS NOT NULL
      UNION
      -- Subscribers matching warehouse / role / class / severity.
      SELECT s.user_id
        FROM public.wms_exception_subscriptions s
       WHERE s.active
         AND s.business_id = p_exception.business_id
         AND (s.warehouse_id IS NULL OR s.warehouse_id = p_exception.warehouse_id)
         AND (s.owner_role IS NULL OR s.owner_role = p_exception.owner_role)
         AND (s.exception_class IS NULL OR s.exception_class = p_exception.class)
         AND p_exception.severity >= s.min_severity
         AND CASE p_event
               WHEN 'raised'    THEN s.notify_on_raise
               WHEN 'escalated' THEN s.notify_on_escalate
               WHEN 'resolved'  THEN s.notify_on_resolve
               ELSE true
             END
    ) u
    WHERE u.user_id IS NOT NULL
      -- Honour the user's in-app notification preference for this category.
      AND NOT EXISTS (
        SELECT 1 FROM public.notification_preferences np
         WHERE np.user_id = u.user_id
           AND np.category = 'warehouse_exceptions'
           AND np.in_app_enabled = false
      )
  LOOP
    INSERT INTO public.notifications (
      organization_id, business_id, user_id, type, category, title, message,
      link, entity_type, entity_id, priority
    ) VALUES (
      p_exception.organization_id, p_exception.business_id, v_user,
      CASE WHEN p_exception.severity >= 4 OR p_event = 'escalated' THEN 'error'
           WHEN p_exception.severity = 3 THEN 'warning' ELSE 'info' END,
      'warehouse_exceptions', v_title,
      COALESCE(p_exception.reason, 'Warehouse exception requires attention'),
      '/warehouse-app/exceptions?id=' || p_exception.id::text,
      'wms_exception', p_exception.id, v_priority
    );
  END LOOP;

  -- Publish to the shared business event stream.
  INSERT INTO public.business_event_outbox (
    org_id, warehouse_id, event_type, source_doc_type, source_doc_id,
    payload, status, idempotency_key, actor_user_id, source
  ) VALUES (
    p_exception.organization_id, p_exception.warehouse_id,
    'warehouse.exception.' || p_event, 'wms_exception', p_exception.id,
    jsonb_build_object(
      'exception_id', p_exception.id, 'kind', p_exception.kind,
      'class', p_exception.class, 'state', p_exception.state,
      'severity', p_exception.severity, 'owner_role', p_exception.owner_role,
      'warehouse_id', p_exception.warehouse_id,
      'aggregate_type', p_exception.aggregate_type,
      'aggregate_id', p_exception.aggregate_id,
      'assigned_to', p_exception.assigned_to,
      'escalation_level', p_exception.escalation_level,
      'due_by', p_exception.due_by,
      'financial_impact', p_exception.financial_impact
    ),
    'pending',
    'wms.exception.' || p_event || ':' || p_exception.id::text || ':' || p_exception.row_version::text,
    auth.uid(), 'wms'
  ) ON CONFLICT DO NOTHING;
END $$;

-- ------------------------------------------------------------------
-- Triggers: raise / assign / escalate / close.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wms_exception_notify_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public._wms_notify_exception(NEW, 'raised');
    ELSE
      IF NEW.assigned_to IS NOT NULL AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
        PERFORM public._wms_notify_exception(NEW, 'assigned');
      END IF;
      IF COALESCE(NEW.escalation_level,0) > COALESCE(OLD.escalation_level,0) THEN
        PERFORM public._wms_notify_exception(NEW, 'escalated');
      END IF;
      IF NEW.state::text IN ('resolved','wont_fix')
         AND OLD.state::text NOT IN ('resolved','wont_fix') THEN
        PERFORM public._wms_notify_exception(NEW, 'resolved');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'exception notification failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wms_exceptions_notify ON public.wms_exceptions;
CREATE TRIGGER wms_exceptions_notify
  AFTER INSERT OR UPDATE OF assigned_to, escalation_level, state
  ON public.wms_exceptions
  FOR EACH ROW EXECUTE FUNCTION public._wms_exception_notify_trigger();
