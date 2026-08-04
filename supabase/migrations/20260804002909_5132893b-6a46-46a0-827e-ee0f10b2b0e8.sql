CREATE OR REPLACE FUNCTION public._wms_notify_exception(
  p_exception public.wms_exceptions,
  p_event text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid;
  v_title text;
  v_priority integer;
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
    WHEN p_event = 'escalated' OR p_exception.severity >= 4 THEN 3
    WHEN p_exception.severity = 3 THEN 2
    ELSE 1
  END;

  FOR v_user IN
    SELECT DISTINCT u.user_id FROM (
      SELECT p_exception.assigned_to AS user_id
       WHERE p_exception.assigned_to IS NOT NULL
      UNION
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
    auth.uid(), 'warehouse'
  ) ON CONFLICT DO NOTHING;
END $$;
